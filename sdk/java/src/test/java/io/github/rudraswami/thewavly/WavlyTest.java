package io.github.rudraswami.thewavly;

import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** Runs without a test framework: java WavlyTest. Exits non-zero on the first failure. */
public final class WavlyTest {
  static int passed = 0;

  static void check(boolean ok, String what) {
    if (!ok) { System.err.println("FAIL: " + what); System.exit(1); }
    passed++;
  }

  static String sign(String secret, String body, long ts) throws Exception {
    Mac mac = Mac.getInstance("HmacSHA256");
    mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
    StringBuilder hex = new StringBuilder();
    for (byte b : mac.doFinal((ts + "." + body).getBytes(StandardCharsets.UTF_8))) hex.append(String.format("%02x", b));
    return "t=" + ts + ",v1=" + hex;
  }

  static boolean throwsAny(Runnable r) { try { r.run(); return false; } catch (RuntimeException e) { return true; } }

  public static void main(String[] args) throws Exception {
    check(throwsAny(() -> new Wavly("pk_nope")), "a non-secret key is refused");

    // JSON round trip, including Indian text and escapes
    Map<String, Object> o = Wavly.obj("item", "साड़ी \"silk\"", "amount_paise", 249900, "ok", true, "list", List.of(1, 2));
    @SuppressWarnings("unchecked") Map<String, Object> back = (Map<String, Object>) Wavly.Json.read(Wavly.Json.write(o));
    check("साड़ी \"silk\"".equals(back.get("item")) && Long.valueOf(249900).equals(back.get("amount_paise")) && Boolean.TRUE.equals(back.get("ok")), "JSON round trip");

    // Canonical JSON matches JavaScript's: sorted keys, short escapes
    check("{\"a\":[1,{\"a\":true,\"b\":\"x\\ny\"}],\"z\":\"₹\"}".equals(Wavly.canonical(Wavly.obj("z", "₹", "a", List.of(1, Wavly.obj("b", "x\ny", "a", true))))), "canonical JSON sorts keys at every level");

    // Webhooks
    String body = "{\"type\":\"check.created\",\"data\":{\"id\":\"chk_1\"}}";
    long now = System.currentTimeMillis() / 1000;
    check("check.created".equals(Wavly.verifyWebhook(body, sign("whsec_x", body, now), "whsec_x", 300).get("type")), "a good webhook verifies");
    String good = sign("whsec_x", body, now);
    check(throwsAny(() -> Wavly.verifyWebhook(body + " ", good, "whsec_x", 300)), "a changed webhook body fails");
    String old = sign("whsec_x", body, now - 3600);
    check(throwsAny(() -> Wavly.verifyWebhook(body, old, "whsec_x", 300)), "an old webhook fails");

    // Retries keep the idempotency key; errors carry code, field and request id
    List<String> keys = new ArrayList<>();
    HttpServer srv = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    srv.createContext("/v1/checks", ex -> {
      keys.add(ex.getRequestHeaders().getFirst("Idempotency-Key"));
      byte[] out = (keys.size() == 1 ? "{\"error\":{\"code\":\"unavailable\",\"message\":\"again\"}}" : "{\"id\":\"chk_1\",\"decision\":\"proceed\"}").getBytes(StandardCharsets.UTF_8);
      ex.sendResponseHeaders(keys.size() == 1 ? 503 : 200, out.length); ex.getResponseBody().write(out); ex.close();
    });
    srv.createContext("/v1/mandates", ex -> {
      byte[] out = "{\"error\":{\"code\":\"invalid_field\",\"message\":\"bad\",\"field\":\"rules.items\",\"request_id\":\"req_1\"}}".getBytes(StandardCharsets.UTF_8);
      ex.sendResponseHeaders(422, out.length); ex.getResponseBody().write(out); ex.close();
    });
    srv.start();
    Wavly local = new Wavly("sk_test_x", "http://127.0.0.1:" + srv.getAddress().getPort(), 2, Duration.ofSeconds(5));
    check("proceed".equals(local.checks().create(Wavly.obj("mandate", "mdt_1")).get("decision")), "a retried request succeeds");
    check(keys.size() == 2 && keys.get(0) != null && keys.get(0).equals(keys.get(1)), "a retried write reuses its idempotency key");
    try { local.mandates().create(Wavly.obj()); check(false, "an error answer throws"); }
    catch (Wavly.WavlyException e) { check(e.status == 422 && "invalid_field".equals(e.code) && "rules.items".equals(e.field) && "req_1".equals(e.requestId), "errors carry code, field and request id"); }
    srv.stop(0);

    // Against a live TheWavly instance, when the Node test suite provides one
    String base = System.getenv("WAVLY_TEST_BASE_URL"), key = System.getenv("WAVLY_TEST_KEY");
    if (base != null && key != null) {
      Wavly s = new Wavly(key, base, 2, Duration.ofSeconds(15));
      Map<String, Object> m = s.mandates().create(Wavly.obj("instruction", "Buy Amma a saree for up to ₹2,500", "approved_by", "user_java",
          "rules", Wavly.obj("items", List.of("Saree"), "max_amount_paise", 250000, "payees", List.of("sarees@okhdfc"))));
      Map<String, Object> ok = s.checks().create(Wavly.obj("mandate", m.get("id"), "purchase", Wavly.obj("item", "Saree", "amount_paise", 249900, "payee", "sarees@okhdfc")));
      check("proceed".equals(ok.get("decision")), "live: a matching purchase proceeds");
      Map<String, Object> stop = s.checks().create(Wavly.obj("mandate", m.get("id"), "purchase", Wavly.obj("item", "Saree", "amount_paise", 100000, "payee", "ｓａｒｅｅｓ@okhdfc")));
      check("stop".equals(stop.get("decision")), "live: a look-alike payee stops");
      check(ok.get("id").equals(s.checks().retrieve((String) ok.get("id")).get("id")), "live: retrieve");
      check("UPI-JAVA-1".equals(s.checks().reportOutcome((String) ok.get("id"), Wavly.obj("status", "paid", "payment_reference", "UPI-JAVA-1")).get("payment_reference")), "live: outcome");

      // A registered agent: checks signed in Java verify, and the store gets the headers
      String handle = "java-agent-" + (System.nanoTime() % 1_000_000_000L);
      s.registry().register(Wavly.obj("handle", handle, "name", "Java Agent", "website", "java-agent.in"));
      java.security.KeyPair kp = java.security.KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
      byte[] pk8 = kp.getPrivate().getEncoded(), x509 = kp.getPublic().getEncoded();
      java.util.Base64.Encoder b64 = java.util.Base64.getUrlEncoder().withoutPadding();
      String x = b64.encodeToString(java.util.Arrays.copyOfRange(x509, x509.length - 32, x509.length));
      Map<String, Object> jwk = Wavly.obj("kty", "OKP", "crv", "Ed25519", "x", x, "d", b64.encodeToString(java.util.Arrays.copyOfRange(pk8, pk8.length - 32, pk8.length)));
      Map<String, Object> added = s.registry().addKey(handle, Wavly.obj("jwk", Wavly.obj("kty", "OKP", "crv", "Ed25519", "x", x)));
      check(Wavly.keyId(jwk).equals(added.get("kid")), "live: the SDK computes the same key id as TheWavly");
      Wavly agent = s.withAgent(handle, jwk);
      Map<String, Object> m2 = agent.mandates().create(Wavly.obj("instruction", "A kit up to ₹600", "approved_by", "java_user", "rules", Wavly.obj("items", List.of("Masala dosa kit"), "max_amount_paise", 60000)));
      Map<String, Object> signed = agent.checks().create(Wavly.obj("mandate", m2.get("id"), "purchase", Wavly.obj("item", "Masala dosa kit", "amount_paise", 56100, "terms", Wavly.obj("veg", true, "note", "line1\nline2"))));
      @SuppressWarnings("unchecked") Map<String, Object> av = (Map<String, Object>) signed.get("agent_verification");
      check("verified".equals(av.get("status")) && Boolean.TRUE.equals(av.get("registry")), "live: a check signed in Java verifies as the registered agent");
      Map<String, String> h = Wavly.checkoutHeaders(signed, handle);
      check(handle.equals(h.get("Wavly-Agent")), "live: checkout headers");
      check(Boolean.FALSE.equals(Wavly.verifyOrder(base, handle, h.get("Wavly-Payment-Token")).get("accept")), "live: an agent without a proved website is not accepted");
      check("paid".equals(Wavly.redeemPaymentToken(base, h.get("Wavly-Payment-Token"), 56100, null, "JAVA-ORDER-1").get("status")), "live: redeem once");
      check(throwsAny(() -> Wavly.redeemPaymentToken(base, h.get("Wavly-Payment-Token"), 56100, null, "JAVA-ORDER-2")), "live: a token pays once");
      check(throwsAny(() -> Wavly.checkoutHeaders(Wavly.obj(), handle)), "a check without a token has no headers");
      System.out.println("live checks ran");
    }
    System.out.println("ok " + passed + " checks");
  }
}
