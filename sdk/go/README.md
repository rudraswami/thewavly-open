# TheWavly Go SDK

Check an AI agent's purchase against what the user approved, before it pays. Go 1.21 or newer, standard library only.

## Install from the SDK bundle

Download the Apache-2.0 SDK bundle into your application directory and extract it:

```bash
curl -fL https://thewavly.com/sdk/thewavly-open.tar.gz -o thewavly-open.tar.gz
tar -xzf thewavly-open.tar.gz
```

From your application's directory, which must already contain a `go.mod`, use the extracted source as a local module:

```bash
go mod edit -replace=github.com/rudraswami/thewavly-open/sdk/go=./thewavly-open/sdk/go
go mod edit -require=github.com/rudraswami/thewavly-open/sdk/go@v0.0.0
```

Create a module first with `go mod init example.com/my-agent` if this is a new Go application. The local replacement avoids fetching an unpublished module.


```go
import wavly "github.com/rudraswami/thewavly-open/sdk/go"

client, err := wavly.New(os.Getenv("WAVLY_API_KEY"))
m, err := client.Mandates.Create(ctx, wavly.Object{
	"instruction": "Buy Amma a saree for up to ₹2,500", "approved_by": "user_7f3",
	"rules": wavly.Object{"items": []string{"Saree"}, "max_amount_paise": 250000, "payees": []string{"sarees@okhdfc"}},
})
c, err := client.Checks.Create(ctx, wavly.Object{"mandate": m["id"],
	"purchase": wavly.Object{"item": "Saree", "amount_paise": 249900, "payee": "sarees@okhdfc"}})
switch c["decision"] {
case "proceed": // pay, then report the outcome
	client.Checks.ReportOutcome(ctx, c["id"].(string), wavly.Object{"status": "paid", "payment_reference": ref})
case "ask": // send the user c["approval"].(map[string]any)["url"]
default: // stop: do not pay
}
```

- **Retries:** writes carry an `Idempotency-Key`. Network errors, 429, 5xx and "busy" answers are retried, honouring `Retry-After`.
- **Errors:** failures return `*wavly.Error`, with `Status`, `Code`, `Message`, `Field` and `RequestID`.
- **Webhooks:** `wavly.VerifyWebhook(body, r.Header.Get("Wavly-Signature"), secret, 0)` checks the signature and the time window, then returns the event.
- **Tests:** run `go test ./...`. Set `WAVLY_TEST_BASE_URL` and `WAVLY_TEST_KEY` (a test key) to also run against a live TheWavly deployment.

## A registered agent, at checkout

```go
client, _ := wavly.New(key, wavly.WithAgent("acme-travelbot", privateKey))   // ed25519.PrivateKey
c, _ := client.Checks.Create(ctx, wavly.Object{"mandate": mandateID, "purchase": purchase})   // signed
headers, err := wavly.CheckoutHeaders(c, "acme-travelbot")   // Wavly-Agent and Wavly-Payment-Token for the store
```

Register the agent and its key with `client.Registry`. Use `wavly.PublicJWK(privateKey)` for the key and `wavly.KeyID` for its id.

For merchants, no key needed: call `wavly.VerifyOrder(ctx, "", agent, token)` before charging, then `wavly.RedeemPaymentToken(...)` once.
