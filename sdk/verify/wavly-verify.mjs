#!/usr/bin/env node
// Verifies a TheWavly evidence pack completely offline, with no dependencies and no call to TheWavly.
//
//   node wavly-verify.mjs wavly-evidence-chk_….json            (exit code 0 when everything verifies)
//   node wavly-verify.mjs pack.json --jwks jwks.json            (use keys you fetched yourself instead of the pack's)
//
// It checks every mandate version's signature and hash chain, the receipt's signature and the purchase it commits to,
// each dispute finding (signature, evidence digests, appeal chain), each fulfilment report (signature, content, chain),
// and the pack signature over the whole document.
// The format is described in spec/wavly-formats-v1.md.
import { readFileSync } from "node:fs";
import { createHash, createPublicKey, verify } from "node:crypto";
import { pathToFileURL } from "node:url";

const sha = text => createHash("sha256").update(text).digest("base64url");
const part = s => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));

// A TheWavly token: base64url(JSON payload) "." base64url(Ed25519 signature over the first part)
export function verifyToken(token, keys) {
  const [body, sig, extra] = String(token).split(".");
  if (!body || !sig || extra !== undefined) throw new Error("not a TheWavly token");
  const payload = part(body), jwk = keys.find(k => k.kid === payload.kid);
  if (!jwk) throw new Error("signed by an unknown key " + payload.kid);
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: jwk.x }, format: "jwk" });
  if (!verify(null, Buffer.from(body), key, Buffer.from(sig, "base64url"))) throw new Error("signature does not match");
  return payload;
}

export function verifyPack(pack, keys = pack.keys) {
  const results = [];
  const step = (name, fn) => { try { const note = fn(); results.push({ name, ok: true, note: note || "" }); } catch (e) { results.push({ name, ok: false, note: e.message }); } };
  // 1. The mandate chain
  let prev = null;
  for (const v of pack.mandate?.chain || []) {
    step("mandate v" + v.version + " " + (v.token.startsWith("erased:") ? "(erased)" : "signature"), () => {
      if (v.version > 1 && v.prev_hash !== prev) throw new Error("prev_hash does not match the previous version");
      if (v.token.startsWith("erased:")) { prev = v.token.slice(7); return "personal data erased; kept as its hash"; }
      const p = verifyToken(v.token, keys);
      if (p.id !== pack.mandate.id || p.ver !== v.version) throw new Error("the token is for another mandate or version");
      prev = sha(v.token);
      return p.instruction && pack.instruction && v.version === pack.mandate.version ? (p.instruction === sha(pack.instruction) ? "instruction matches its hash" : "instruction does not match its hash (erased?)") : "";
    });
  }
  // 2. The receipt
  step("receipt", () => {
    const r = verifyToken(pack.check.receipt, keys);
    if (r.id !== pack.check.id || r.mandate !== pack.mandate.id) throw new Error("the receipt is for another check or mandate");
    const ok = r.purchase === sha(JSON.stringify(pack.check.purchase));
    return r.decision + " · " + (r.basis === "user_approval" ? "approved by the user" : "by the rules") + (ok ? " · purchase matches" : " · purchase differs from the receipt's hash (erased?)") + (r.agent_kid ? " · signed by agent " + r.agent : "");
  });
  // 3. Disputes
  for (const d of pack.disputes || []) {
    const digests = new Set((d.evidence || []).map(e => e.digest));
    let before = null, freshReview = null;
    for (const x of d.decisions || []) step("dispute " + d.id + " " + x.stage + " finding", () => {
      const f = verifyToken(x.token, keys);
      if (f.typ !== "finding" || f.dispute !== d.id || f.finding !== x.finding || f.stage !== x.stage || f.reviewer !== x.reviewer?.id) throw new Error("the finding token does not match the record");
      for (const e of f.evidence) if (!digests.has(e)) throw new Error("the finding relied on evidence not in the pack");
      if (x.stage === "appeal" && f.prev !== before) throw new Error("the appeal does not commit to the first finding");
      if (x.confirmed_review) {
        const review = x.confirmed_review, proof = verifyToken(review.token, keys);
        if (proof.typ !== "finding_confirmation" || proof.dispute !== d.id || proof.first !== sha(x.token) ||
            proof.reviewer !== review.reviewer.id || proof.note !== sha(review.note)) throw new Error("the fresh review does not match its record");
        freshReview = review;
      }
      if (f.first_review && (!freshReview || f.first_review !== sha(freshReview.token) || freshReview.reviewer.id === f.reviewer || f.independent_review !== true))
        throw new Error("the appeal does not establish an independent review");
      before = sha(x.token);
      return x.finding + " · " + f.evidence.length + " pieces of evidence";
    });
  }
  // 4. Fulfilment: each report signed, committing to its content and to the report before it for the same check
  let lastFul = null;
  for (const f of pack.fulfilment || []) step("fulfilment " + f.id + " (" + f.status + ")", () => {
    const p = verifyToken(f.token, keys);
    if (p.typ !== "fulfilment" || p.id !== f.id || p.check !== pack.check.id || p.status !== f.status || p.party !== f.party) throw new Error("the token does not match the record");
    if (p.prev !== lastFul) throw new Error("prev does not match the report before it");
    if ((p.items ?? null) !== (f.items ? sha(JSON.stringify(f.items)) : null)) throw new Error("the items differ from what was signed");
    if ((p.amount_paise ?? null) !== (f.amount_paise ?? null)) throw new Error("the amount differs from what was signed");
    if (f.note != null && p.note !== sha(f.note)) throw new Error("the note differs from what was signed");
    lastFul = sha(f.token);
    return "by the " + f.party.replace(/_/g, " ") + (f.erased ? " · note and tracking erased" : "");
  });
  // 5. The whole document
  step("pack signature", () => {
    const { pack_signature, ...rest } = pack;
    const s = verifyToken(pack_signature, keys);
    if (s.digest !== sha(JSON.stringify(rest))) throw new Error("the document was changed after it was signed");
    return "generated " + new Date(s.iat * 1000).toISOString();
  });
  return { ok: results.every(r => r.ok), results };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const [file, flag, jwksFile] = process.argv.slice(2);
  if (!file) { console.error("Usage: node wavly-verify.mjs <evidence-pack.json> [--jwks <jwks.json>]"); process.exit(2); }
  const pack = JSON.parse(readFileSync(file, "utf8"));
  const keys = flag === "--jwks" ? (j => j.keys || j)(JSON.parse(readFileSync(jwksFile, "utf8"))) : pack.keys;
  const out = verifyPack(pack, keys);
  for (const r of out.results) console.log((r.ok ? "✓ " : "✗ ") + r.name + (r.note ? "  " + r.note : ""));
  console.log(out.ok ? "\nEverything verifies." : "\nSomething does not verify.");
  process.exit(out.ok ? 0 : 1);
}
