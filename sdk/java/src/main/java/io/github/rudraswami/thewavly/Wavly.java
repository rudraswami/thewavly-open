package io.github.rudraswami.thewavly;

import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * Checks an AI agent's purchase against what the user approved, before it pays. Java 11 or newer, no dependencies.
 *
 * <pre>{@code
 * TheWavly wavly = new Wavly(System.getenv("WAVLY_API_KEY"));
 * Map<String, Object> m = wavly.mandates().create(Wavly.obj("instruction", "Buy Amma a saree for up to ₹2,500", "approved_by", "user_7f3",
 *     "rules", Wavly.obj("items", List.of("Saree"), "max_amount_paise", 250000)));
 * Map<String, Object> c = wavly.checks().create(Wavly.obj("mandate", m.get("id"), "purchase", Wavly.obj("item", "Saree", "amount_paise", 249900)));
 * // c.get("decision") is "proceed", "ask" or "stop"
 * }</pre>
 *
 * Writes carry an Idempotency-Key, so a retried write is never applied twice.
 */
public final class Wavly {
  public static final String DEFAULT_BASE_URL = "https://thewavly.com";
  private static final String USER_AGENT = "wavly-java/0.1";
  private static final SecureRandom RANDOM = new SecureRandom();

  private final String apiKey;
  private final String baseUrl;
  private final HttpClient http;
  private final int maxRetries;
  private final Duration timeout;
  private final String agentId;
  private final Map<String, Object> agentKey;

  public Wavly(String apiKey) { this(apiKey, DEFAULT_BASE_URL, 2, Duration.ofSeconds(15)); }

  private Wavly(Wavly from, String agentId, Map<String, Object> agentKey) {
    this.apiKey = from.apiKey; this.baseUrl = from.baseUrl; this.maxRetries = from.maxRetries; this.timeout = from.timeout; this.http = from.http;
    this.agentId = agentId; this.agentKey = agentKey;
  }

  /**
   * A client that acts as an agent in TheWavly's public registry: every check names the agent and is signed with its
   * private key (an Ed25519 or P-256 JWK with "d"), so it counts toward the agent's public record. Ed25519 needs Java 15+.
   */
  public Wavly withAgent(String id, Map<String, Object> privateJwk) {
    if (id == null || id.isEmpty()) throw new IllegalArgumentException("withAgent needs the agent's registry handle or id");
    if (privateJwk != null && privateJwk.get("d") == null) throw new IllegalArgumentException("Sign with the agent's private key: this JWK has no \"d\"");
    return new Wavly(this, id, privateJwk);
  }

  /** The agent's registry handle or id, when this client acts as one. */
  public String agentId() { return agentId; }

  public Wavly(String apiKey, String baseUrl, int maxRetries, Duration timeout) {
    if (apiKey == null || !(apiKey.startsWith("sk_test_") || apiKey.startsWith("sk_live_")))
      throw new IllegalArgumentException("TheWavly needs a secret key that starts with sk_test_ or sk_live_");
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replaceAll("/+$", "");
    this.maxRetries = maxRetries;
    this.timeout = timeout;
    this.http = HttpClient.newBuilder().connectTimeout(timeout).build();
    this.agentId = null; this.agentKey = null;
  }

  /** An error answer from the API. */
  public static final class WavlyException extends RuntimeException {
    private static final long serialVersionUID = 1L;
    public final int status;
    public final String code, field, requestId;

    WavlyException(int status, String code, String message, String field, String requestId) {
      super("TheWavly " + status + " " + code + ": " + message + (field != null ? " (" + field + ")" : "") + (requestId != null ? " [request " + requestId + "]" : ""));
      this.status = status; this.code = code; this.field = field; this.requestId = requestId;
    }
  }

  /** Builds a JSON object from key, value pairs. */
  public static Map<String, Object> obj(Object... kv) {
    Map<String, Object> m = new LinkedHashMap<>();
    for (int i = 0; i + 1 < kv.length; i += 2) m.put(String.valueOf(kv[i]), kv[i + 1]);
    return m;
  }

  private static String newKey() {
    byte[] b = new byte[16];
    RANDOM.nextBytes(b);
    StringBuilder s = new StringBuilder();
    for (byte x : b) s.append(String.format("%02x", x));
    return s.toString();
  }

  /** Sends one request and decodes the JSON answer. POSTs get an idempotency key unless one is given. */
  @SuppressWarnings("unchecked")
  public Map<String, Object> request(String method, String path, Object body, String idempotencyKey) {
    String payload = body == null ? null : Json.write(body);
    if ("POST".equals(method) && idempotencyKey == null) idempotencyKey = newKey();
    for (int attempt = 0; ; attempt++) {
      HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(baseUrl + path)).timeout(timeout)
          .header("Authorization", "Bearer " + apiKey).header("User-Agent", USER_AGENT)
          .method(method, payload == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(payload, StandardCharsets.UTF_8));
      if (payload != null) b.header("Content-Type", "application/json");
      if (idempotencyKey != null) b.header("Idempotency-Key", idempotencyKey);
      HttpResponse<String> res;
      try {
        res = http.send(b.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
      } catch (IOException e) {
        if (attempt < maxRetries) { sleep(backoff(attempt, 0)); continue; }
        throw new RuntimeException("TheWavly could not be reached: " + e.getMessage(), e);
      } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
        throw new RuntimeException(e);
      }
      Object parsed;
      try { parsed = res.body().isEmpty() ? null : Json.read(res.body()); } catch (RuntimeException e) { parsed = null; }
      Map<String, Object> data = parsed instanceof Map ? (Map<String, Object>) parsed : new LinkedHashMap<>();
      if (res.statusCode() >= 200 && res.statusCode() < 300) return data;
      Map<String, Object> err = data.get("error") instanceof Map ? (Map<String, Object>) data.get("error") : new LinkedHashMap<>();
      String code = (String) err.get("code");
      String requestId = err.get("request_id") != null ? (String) err.get("request_id") : res.headers().firstValue("Request-Id").orElse(null);
      boolean retryable = res.statusCode() == 429 || res.statusCode() >= 500 || (res.statusCode() == 409 && "busy".equals(code));
      if (retryable && attempt < maxRetries) {
        long after = res.headers().firstValue("Retry-After").map(v -> { try { return Long.parseLong(v); } catch (NumberFormatException e) { return 0L; } }).orElse(0L);
        sleep(backoff(attempt, after));
        continue;
      }
      throw new WavlyException(res.statusCode(), code, (String) err.get("message"), (String) err.get("field"), requestId);
    }
  }

  private static long backoff(int attempt, long retryAfterSeconds) { return Math.max(retryAfterSeconds * 1000, (long) (400 * Math.pow(2, attempt))); }

  private static void sleep(long ms) {
    try { Thread.sleep(ms); } catch (InterruptedException e) { Thread.currentThread().interrupt(); throw new RuntimeException(e); }
  }

  private static String enc(String s) { return URLEncoder.encode(s, StandardCharsets.UTF_8).replace("+", "%20"); }

  /** What the user approved. */
  public final class Mandates {
    public Map<String, Object> create(Map<String, Object> params) { return request("POST", "/v1/mandates", params, null); }
    public Map<String, Object> retrieve(String id) { return request("GET", "/v1/mandates/" + enc(id), null, null); }
    public Map<String, Object> revoke(String id, Map<String, Object> params) { return request("POST", "/v1/mandates/" + enc(id) + "/revoke", params == null ? obj() : params, null); }
  }

  /** A purchase checked before payment: proceed, ask or stop. */
  public final class Checks {
    /** With withAgent, the check names the agent and is signed with its key (unless already signed). */
    @SuppressWarnings("unchecked")
    public Map<String, Object> create(Map<String, Object> params) {
      if (agentId != null && params.get("agent_signature") == null) {
        Map<String, Object> p = new LinkedHashMap<>(params);
        p.putIfAbsent("agent", agentId);
        if (agentKey != null) p.put("agent_signature", signCheck(agentKey, (String) p.get("mandate"), p.get("purchase")));
        params = p;
      }
      return request("POST", "/v1/checks", params, null);
    }
    public Map<String, Object> retrieve(String id) { return request("GET", "/v1/checks/" + enc(id), null, null); }
    /** A new single-use payment token for a check that may proceed, for example after the user approved. */
    public Map<String, Object> paymentToken(String id) { return request("POST", "/v1/checks/" + enc(id) + "/payment_token", obj(), null); }
    /** Records paid, failed or cancelled, so budgets stay right. */
    public Map<String, Object> reportOutcome(String id, Map<String, Object> params) { return request("POST", "/v1/checks/" + enc(id) + "/outcome", params, null); }
    /** The signed evidence pack for a check. */
    public Map<String, Object> evidence(String id) { return request("GET", "/v1/checks/" + enc(id) + "/evidence", null, null); }
    /** Records what happened to the order: delivered, partially_delivered, not_delivered, returned, refunded or cancelled. */
    public Map<String, Object> reportFulfilment(String id, Map<String, Object> body, String idempotencyKey) { return request("POST", "/v1/checks/" + enc(id) + "/fulfilment", body, idempotencyKey); }
    public Map<String, Object> fulfilment(String id) { return request("GET", "/v1/checks/" + enc(id) + "/fulfilment", null, null); }
  }

  /** The user's answer to an "ask". */
  public final class Approvals {
    public Map<String, Object> retrieve(String id) { return request("GET", "/v1/approvals/" + enc(id), null, null); }
  }

  /** Disputes about agent purchases. */
  public final class Disputes {
    public Map<String, Object> create(Map<String, Object> params) { return request("POST", "/v1/disputes", params, null); }
    public Map<String, Object> retrieve(String id) { return request("GET", "/v1/disputes/" + enc(id), null, null); }
  }

  /** TheWavly's public registry of agents: register, prove the website, add keys. */
  public final class Registry {
    private String p(String agent) { return "/v1/registry/agents/" + enc(agent); }
    public Map<String, Object> register(Map<String, Object> params) { return request("POST", "/v1/registry/agents", params, null); }
    public Map<String, Object> mine() { return request("GET", "/v1/registry/agents?mine=true", null, null); }
    public Map<String, Object> retrieve(String agent) { return request("GET", p(agent), null, null); }
    public Map<String, Object> verifyDomain(String agent) { return request("POST", p(agent) + "/verify", obj(), null); }
    public Map<String, Object> addKey(String agent, Map<String, Object> params) { return request("POST", p(agent) + "/keys", params, null); }
    public Map<String, Object> revokeKey(String agent, String kid) { return request("POST", p(agent) + "/keys/" + enc(kid) + "/revoke", obj(), null); }
  }

  public Registry registry() { return new Registry(); }

  private static final java.util.Base64.Encoder B64U = java.util.Base64.getUrlEncoder().withoutPadding();
  private static final java.util.Base64.Decoder B64D = java.util.Base64.getUrlDecoder();

  /** JSON with object keys sorted, written as JavaScript writes it: how TheWavly hashes a purchase for agent signatures. */
  @SuppressWarnings("unchecked")
  public static String canonical(Object v) {
    if (v instanceof Map) {
      java.util.TreeMap<String, Object> sorted = new java.util.TreeMap<>();
      for (Map.Entry<Object, Object> e : ((Map<Object, Object>) v).entrySet()) sorted.put(String.valueOf(e.getKey()), e.getValue());
      StringBuilder b = new StringBuilder("{"); boolean first = true;
      for (Map.Entry<String, Object> e : sorted.entrySet()) { if (!first) b.append(','); first = false; b.append(Json.write(e.getKey())).append(':').append(canonical(e.getValue())); }
      return b.append('}').toString();
    }
    if (v instanceof Iterable) {
      StringBuilder b = new StringBuilder("["); boolean first = true;
      for (Object x : (Iterable<Object>) v) { if (!first) b.append(','); first = false; b.append(canonical(x)); }
      return b.append(']').toString();
    }
    return Json.write(v);
  }

  private static String sha256b64u(String text) {
    try { return B64U.encodeToString(MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8))); }
    catch (java.security.GeneralSecurityException e) { throw new IllegalStateException(e); }
  }

  /** The RFC 7638 thumbprint TheWavly uses as a key id. */
  public static String keyId(Map<String, Object> jwk) {
    String kty = (String) jwk.get("kty");
    return sha256b64u("EC".equals(kty)
        ? "{\"crv\":\"" + jwk.get("crv") + "\",\"kty\":\"EC\",\"x\":\"" + jwk.get("x") + "\",\"y\":\"" + jwk.get("y") + "\"}"
        : "{\"crv\":\"" + jwk.get("crv") + "\",\"kty\":\"" + kty + "\",\"x\":\"" + jwk.get("x") + "\"}");
  }

  /** Signs a check with the agent's private JWK (Ed25519 or P-256). Send it as agent_signature with exactly the same purchase. */
  public static String signCheck(Map<String, Object> privateJwk, String mandate, Object purchase) {
    boolean ed = "OKP".equals(privateJwk.get("kty")) && "Ed25519".equals(privateJwk.get("crv"));
    if (!ed && !"P-256".equals(privateJwk.get("crv"))) throw new IllegalArgumentException("The agent's key must be Ed25519 (OKP) or P-256 (EC)");
    byte[] d = B64D.decode((String) privateJwk.get("d"));
    String header = Json.write(obj("alg", ed ? "EdDSA" : "ES256", "kid", keyId(privateJwk), "typ", "wavly-check+jws"));
    byte[] jti = new byte[16]; RANDOM.nextBytes(jti);
    String payload = Json.write(obj("mandate", mandate, "purchase", sha256b64u(canonical(purchase)), "iat", System.currentTimeMillis() / 1000, "jti", B64U.encodeToString(jti)));
    String input = B64U.encodeToString(header.getBytes(StandardCharsets.UTF_8)) + "." + B64U.encodeToString(payload.getBytes(StandardCharsets.UTF_8));
    try {
      java.security.Signature sig;
      if (ed) {
        // PKCS #8 wrapping of a raw Ed25519 seed (RFC 8410)
        byte[] prefix = { 0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20 };
        byte[] der = new byte[prefix.length + d.length];
        System.arraycopy(prefix, 0, der, 0, prefix.length); System.arraycopy(d, 0, der, prefix.length, d.length);
        sig = java.security.Signature.getInstance("Ed25519");
        sig.initSign(java.security.KeyFactory.getInstance("Ed25519").generatePrivate(new java.security.spec.PKCS8EncodedKeySpec(der)));
      } else {
        java.security.AlgorithmParameters params = java.security.AlgorithmParameters.getInstance("EC");
        params.init(new java.security.spec.ECGenParameterSpec("secp256r1"));
        java.security.spec.ECParameterSpec spec = params.getParameterSpec(java.security.spec.ECParameterSpec.class);
        sig = java.security.Signature.getInstance("SHA256withECDSAinP1363Format");
        sig.initSign(java.security.KeyFactory.getInstance("EC").generatePrivate(new java.security.spec.ECPrivateKeySpec(new java.math.BigInteger(1, d), spec)));
      }
      sig.update(input.getBytes(StandardCharsets.UTF_8));
      return input + "." + B64U.encodeToString(sig.sign());
    } catch (java.security.GeneralSecurityException e) {
      throw new IllegalStateException("Could not sign the check: " + e.getMessage(), e);
    }
  }

  /** The headers a store that takes TheWavly reads: the agent's identity and the single-use payment token. */
  @SuppressWarnings("unchecked")
  public static Map<String, String> checkoutHeaders(Map<String, Object> check, String agent) {
    Object t = check.get("payment_token");
    Object token = t instanceof Map ? ((Map<String, Object>) t).get("token") : null;
    if (!(token instanceof String)) throw new IllegalArgumentException("This check has no payment token: it may be paid only once its decision is proceed, or after the user approves");
    if (agent == null || agent.isEmpty()) throw new IllegalArgumentException("checkoutHeaders needs the agent's registry handle or id");
    Map<String, String> h = new LinkedHashMap<>();
    h.put("Wavly-Agent", agent); h.put("Wavly-Payment-Token", (String) token);
    return h;
  }

  /** For merchants, no key needed: is this agent verified, and did its user approve this payment? */
  public static Map<String, Object> verifyOrder(String baseUrl, String agent, String paymentToken) {
    return publicPost(baseUrl, "/v1/registry/verify", obj("agent", agent, "payment_token", paymentToken));
  }

  /** Uses a payment token once, just before charging. Needs no key. payee may be null. */
  public static Map<String, Object> redeemPaymentToken(String baseUrl, String token, long amountPaise, String payee, String paymentReference) {
    Map<String, Object> body = obj("token", token, "amount_paise", amountPaise, "payment_reference", paymentReference, "currency", "INR");
    if (payee != null) body.put("payee", payee);
    return publicPost(baseUrl, "/v1/payment_tokens/redeem", body);
  }

  /** For the store or provider that redeemed the token: report what happened to the order, with the release key. */
  public static Map<String, Object> reportFulfilment(String baseUrl, String token, String releaseKey, String status, Map<String, Object> extra) {
    Map<String, Object> body = new java.util.LinkedHashMap<>(extra == null ? Map.of() : extra);
    body.put("token", token); body.put("release_key", releaseKey); body.put("status", status);
    return publicPost(baseUrl, "/v1/payment_tokens/fulfilment", body);
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> publicPost(String baseUrl, String path, Map<String, Object> body) {
    String base = (baseUrl == null ? DEFAULT_BASE_URL : baseUrl).replaceAll("/+$", "");
    HttpRequest req = HttpRequest.newBuilder(URI.create(base + path)).timeout(Duration.ofSeconds(15))
        .header("Content-Type", "application/json").header("User-Agent", USER_AGENT)
        .POST(HttpRequest.BodyPublishers.ofString(Json.write(body))).build();
    try {
      HttpResponse<String> res = HttpClient.newHttpClient().send(req, HttpResponse.BodyHandlers.ofString());
      Map<String, Object> data = res.body().isEmpty() ? obj() : (Map<String, Object>) Json.read(res.body());
      if (res.statusCode() >= 300) {
        Map<String, Object> e = data.get("error") instanceof Map ? (Map<String, Object>) data.get("error") : obj();
        throw new WavlyException(res.statusCode(), (String) e.get("code"), (String) e.get("message"), (String) e.get("field"), (String) e.get("request_id"));
      }
      return data;
    } catch (IOException e) { throw new java.io.UncheckedIOException(e); }
    catch (InterruptedException e) { Thread.currentThread().interrupt(); throw new RuntimeException(e); }
  }

  public Mandates mandates() { return new Mandates(); }
  public Checks checks() { return new Checks(); }
  public Approvals approvals() { return new Approvals(); }
  public Disputes disputes() { return new Disputes(); }

  private static final Pattern SIGNATURE = Pattern.compile("^t=(\\d+),v1=([0-9a-f]{64})$");

  /**
   * Checks a webhook's Wavly-Signature header against the endpoint's secret and returns the event. Throws if the
   * signature does not match or the timestamp is more than toleranceSeconds away (use 300).
   */
  @SuppressWarnings("unchecked")
  public static Map<String, Object> verifyWebhook(String rawBody, String header, String secret, long toleranceSeconds) {
    Matcher m = SIGNATURE.matcher(header == null ? "" : header);
    if (!m.matches()) throw new IllegalArgumentException("Missing or malformed Wavly-Signature header");
    long ts = Long.parseLong(m.group(1));
    if (Math.abs(System.currentTimeMillis() / 1000 - ts) > toleranceSeconds) throw new IllegalArgumentException("Webhook timestamp is outside the allowed window");
    try {
      Mac mac = Mac.getInstance("HmacSHA256");
      mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
      byte[] want = mac.doFinal((m.group(1) + "." + rawBody).getBytes(StandardCharsets.UTF_8));
      StringBuilder hex = new StringBuilder();
      for (byte x : want) hex.append(String.format("%02x", x));
      if (!MessageDigest.isEqual(hex.toString().getBytes(StandardCharsets.UTF_8), m.group(2).getBytes(StandardCharsets.UTF_8)))
        throw new IllegalArgumentException("Webhook signature does not match");
    } catch (java.security.GeneralSecurityException e) {
      throw new IllegalStateException(e);
    }
    return (Map<String, Object>) Json.read(rawBody);
  }

  /** A small JSON reader and writer, so the client needs no dependencies. Numbers read as Long or Double. */
  public static final class Json {
    private final String s;
    private int i;

    private Json(String s) { this.s = s; }

    public static Object read(String text) {
      Json j = new Json(text);
      Object v = j.value();
      j.ws();
      if (j.i != j.s.length()) throw new IllegalArgumentException("Trailing characters in JSON");
      return v;
    }

    private void ws() { while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++; }

    private Object value() {
      ws();
      if (i >= s.length()) throw new IllegalArgumentException("Unexpected end of JSON");
      char c = s.charAt(i);
      if (c == '{') {
        Map<String, Object> m = new LinkedHashMap<>(); i++; ws();
        if (s.charAt(i) == '}') { i++; return m; }
        while (true) {
          ws(); String k = string(); ws(); expect(':'); m.put(k, value()); ws();
          if (s.charAt(i) == ',') { i++; continue; }
          expect('}'); return m;
        }
      }
      if (c == '[') {
        List<Object> l = new ArrayList<>(); i++; ws();
        if (s.charAt(i) == ']') { i++; return l; }
        while (true) {
          l.add(value()); ws();
          if (s.charAt(i) == ',') { i++; continue; }
          expect(']'); return l;
        }
      }
      if (c == '"') return string();
      if (s.startsWith("true", i)) { i += 4; return Boolean.TRUE; }
      if (s.startsWith("false", i)) { i += 5; return Boolean.FALSE; }
      if (s.startsWith("null", i)) { i += 4; return null; }
      int start = i;
      while (i < s.length() && "+-0123456789.eE".indexOf(s.charAt(i)) >= 0) i++;
      String n = s.substring(start, i);
      if (n.isEmpty()) throw new IllegalArgumentException("Unexpected character in JSON at " + start);
      return n.contains(".") || n.contains("e") || n.contains("E") ? (Object) Double.parseDouble(n) : (Object) Long.parseLong(n);
    }

    private void expect(char c) {
      if (i >= s.length() || s.charAt(i) != c) throw new IllegalArgumentException("Expected '" + c + "' in JSON at " + i);
      i++;
    }

    private String string() {
      expect('"');
      StringBuilder b = new StringBuilder();
      while (true) {
        char c = s.charAt(i++);
        if (c == '"') return b.toString();
        if (c != '\\') { b.append(c); continue; }
        char e = s.charAt(i++);
        switch (e) {
          case 'n': b.append('\n'); break;
          case 't': b.append('\t'); break;
          case 'r': b.append('\r'); break;
          case 'b': b.append('\b'); break;
          case 'f': b.append('\f'); break;
          case 'u': b.append((char) Integer.parseInt(s.substring(i, i + 4), 16)); i += 4; break;
          default: b.append(e);
        }
      }
    }

    public static String write(Object v) {
      StringBuilder b = new StringBuilder();
      write(v, b);
      return b.toString();
    }

    @SuppressWarnings("unchecked")
    private static void write(Object v, StringBuilder b) {
      if (v == null) b.append("null");
      else if (v instanceof String) quote((String) v, b);
      else if (v instanceof Number || v instanceof Boolean) b.append(v);
      else if (v instanceof Map) {
        b.append('{'); boolean first = true;
        for (Map.Entry<Object, Object> e : ((Map<Object, Object>) v).entrySet()) {
          if (!first) b.append(','); first = false;
          quote(String.valueOf(e.getKey()), b); b.append(':'); write(e.getValue(), b);
        }
        b.append('}');
      } else if (v instanceof Iterable) {
        b.append('['); boolean first = true;
        for (Object x : (Iterable<Object>) v) { if (!first) b.append(','); first = false; write(x, b); }
        b.append(']');
      } else if (v instanceof Object[]) write(java.util.Arrays.asList((Object[]) v), b);
      else quote(v.toString(), b);
    }

    private static void quote(String s, StringBuilder b) {
      b.append('"');
      for (char c : s.toCharArray()) {
        if (c == '"' || c == '\\') b.append('\\').append(c);
        else if (c == '\b') b.append("\\b");
        else if (c == '\t') b.append("\\t");
        else if (c == '\n') b.append("\\n");
        else if (c == '\f') b.append("\\f");
        else if (c == '\r') b.append("\\r");
        else if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
        else b.append(c);
      }
      b.append('"');
    }
  }
}
