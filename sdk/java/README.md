# TheWavly Java SDK

Check an AI agent's purchase against what the user approved, before it pays. Java 11 or newer, no dependencies.

## Install from the SDK bundle

Download the Apache-2.0 SDK bundle into your application directory and extract it:

```bash
curl -fL https://thewavly.com/sdk/thewavly-open.tar.gz -o thewavly-open.tar.gz
tar -xzf thewavly-open.tar.gz
```

Compile the dependency-free client with JDK 11 or newer, then add the resulting JAR to your application's classpath:

```bash
mkdir -p wavly-java-classes
javac --release 11 -d wavly-java-classes thewavly-open/sdk/java/src/main/java/io/github/rudraswami/thewavly/Wavly.java
jar --create --file wavly-sdk.jar -C wavly-java-classes .
```


```java
import io.github.rudraswami.thewavly.Wavly;

Wavly wavly = new Wavly(System.getenv("WAVLY_API_KEY"));
Map<String, Object> m = wavly.mandates().create(Wavly.obj(
    "instruction", "Buy Amma a saree for up to ₹2,500", "approved_by", "user_7f3",
    "rules", Wavly.obj("items", List.of("Saree"), "max_amount_paise", 250000, "payees", List.of("sarees@okhdfc"))));
Map<String, Object> c = wavly.checks().create(Wavly.obj("mandate", m.get("id"),
    "purchase", Wavly.obj("item", "Saree", "amount_paise", 249900, "payee", "sarees@okhdfc")));
switch ((String) c.get("decision")) {
  case "proceed": /* pay, then */ wavly.checks().reportOutcome((String) c.get("id"), Wavly.obj("status", "paid", "payment_reference", ref)); break;
  case "ask": /* send the user ((Map) c.get("approval")).get("url") */ break;
  default: /* stop: do not pay */
}
```

- **Retries:** writes carry an `Idempotency-Key`. Network errors, 429, 5xx and "busy" answers are retried, honouring `Retry-After`.
- **Errors:** failures throw `Wavly.WavlyException`, with `status`, `code`, `field` and `requestId`.
- **Webhooks:** `Wavly.verifyWebhook(rawBody, signatureHeader, secret, 300)` checks the signature and the time window, then returns the event.
- **Build:** use the `javac` and `jar` commands above; the client is a single source file.
- **Tests:** `src/test/java/.../WavlyTest.java` runs without a test framework. Set `WAVLY_TEST_BASE_URL` and `WAVLY_TEST_KEY` to also run against a live TheWavly deployment.

## A registered agent, at checkout

```java
Wavly agent = new Wavly(key).withAgent("acme-travelbot", privateJwk);   // Ed25519 (Java 15+) or P-256 JWK with "d"
Map<String, Object> c = agent.checks().create(Wavly.obj("mandate", mandateId, "purchase", purchase));   // signed
Map<String, String> headers = Wavly.checkoutHeaders(c, "acme-travelbot");   // Wavly-Agent and Wavly-Payment-Token
```

`registry()` registers the agent, proves its website and adds its keys.

For merchants, no key needed: call `Wavly.verifyOrder(null, agent, token)` before charging, then `Wavly.redeemPaymentToken(...)` once.
