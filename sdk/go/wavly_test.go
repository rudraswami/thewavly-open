package wavly

import (
	"context"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"sync"
	"testing"
	"time"
)

func sign(secret, body string, ts int64) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(strconv.FormatInt(ts, 10) + "." + body))
	return "t=" + strconv.FormatInt(ts, 10) + ",v1=" + hex.EncodeToString(mac.Sum(nil))
}

func TestNeedsASecretKey(t *testing.T) {
	if _, err := New("pk_nope"); err == nil {
		t.Fatal("a publishable-looking key must be refused")
	}
}

func TestVerifyWebhook(t *testing.T) {
	body := `{"type":"check.created","data":{"id":"chk_1"}}`
	now := time.Now().Unix()
	ev, err := VerifyWebhook([]byte(body), sign("whsec_x", body, now), "whsec_x", 0)
	if err != nil || ev["type"] != "check.created" {
		t.Fatalf("a good signature must verify: %v", err)
	}
	if _, err := VerifyWebhook([]byte(body+" "), sign("whsec_x", body, now), "whsec_x", 0); err == nil {
		t.Fatal("a changed body must fail")
	}
	if _, err := VerifyWebhook([]byte(body), sign("whsec_x", body, now-3600), "whsec_x", 0); err == nil {
		t.Fatal("an old signature must fail")
	}
	if _, err := VerifyWebhook([]byte(body), "nonsense", "whsec_x", 0); err == nil {
		t.Fatal("a malformed header must fail")
	}
}

func TestRetriesKeepTheIdempotencyKey(t *testing.T) {
	var mu sync.Mutex
	var keys []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		keys = append(keys, r.Header.Get("Idempotency-Key"))
		n := len(keys)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		if n == 1 {
			w.WriteHeader(503)
			w.Write([]byte(`{"error":{"code":"unavailable","message":"try again"}}`))
			return
		}
		w.Write([]byte(`{"id":"chk_1","decision":"proceed"}`))
	}))
	defer srv.Close()
	c, _ := New("sk_test_x", WithBaseURL(srv.URL))
	out, err := c.Checks.Create(context.Background(), Object{"mandate": "mdt_1"})
	if err != nil || out["decision"] != "proceed" {
		t.Fatalf("the retry must succeed: %v", err)
	}
	if len(keys) != 2 || keys[0] == "" || keys[0] != keys[1] {
		t.Fatalf("a retried write must reuse its idempotency key: %v", keys)
	}
}

func TestErrorsCarryCodeAndField(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(422)
		w.Write([]byte(`{"error":{"code":"invalid_field","message":"bad","field":"rules.items","request_id":"req_1"}}`))
	}))
	defer srv.Close()
	c, _ := New("sk_test_x", WithBaseURL(srv.URL))
	_, err := c.Mandates.Create(context.Background(), Object{})
	var e *Error
	if !errors.As(err, &e) || e.Status != 422 || e.Code != "invalid_field" || e.Field != "rules.items" || e.RequestID != "req_1" {
		t.Fatalf("unexpected error: %#v", err)
	}
}

// Runs against a live TheWavly instance when WAVLY_TEST_BASE_URL and WAVLY_TEST_KEY are set (the Node test suite starts one).
func TestLive(t *testing.T) {
	base, key := os.Getenv("WAVLY_TEST_BASE_URL"), os.Getenv("WAVLY_TEST_KEY")
	if base == "" || key == "" {
		t.Skip("set WAVLY_TEST_BASE_URL and WAVLY_TEST_KEY to run against a live TheWavly instance")
	}
	ctx := context.Background()
	c, err := New(key, WithBaseURL(base))
	if err != nil {
		t.Fatal(err)
	}
	m, err := c.Mandates.Create(ctx, Object{"instruction": "Buy Amma a saree for up to ₹2,500", "approved_by": "user_go",
		"rules": Object{"items": []string{"Saree"}, "max_amount_paise": 250000, "payees": []string{"sarees@okhdfc"}}})
	if err != nil {
		t.Fatal(err)
	}
	ok, err := c.Checks.Create(ctx, Object{"mandate": m["id"], "purchase": Object{"item": "Saree", "amount_paise": 249900, "payee": "sarees@okhdfc"}})
	if err != nil || ok["decision"] != "proceed" {
		t.Fatalf("a matching purchase must proceed: %v %v", ok["decision"], err)
	}
	stop, _ := c.Checks.Create(ctx, Object{"mandate": m["id"], "purchase": Object{"item": "Saree", "amount_paise": 100000, "payee": "ｓａｒｅｅｓ@okhdfc"}})
	if stop["decision"] != "stop" {
		t.Fatalf("a look-alike payee must stop, got %v", stop["decision"])
	}
	got, err := c.Checks.Retrieve(ctx, ok["id"].(string))
	if err != nil || got["id"] != ok["id"] {
		t.Fatalf("retrieve: %v", err)
	}
	paid, err := c.Checks.ReportOutcome(ctx, ok["id"].(string), Object{"status": "paid", "payment_reference": "UPI-GO-1"})
	if err != nil || paid["payment_reference"] != "UPI-GO-1" {
		t.Fatalf("outcome: %v", err)
	}
	if _, err := c.Mandates.Create(ctx, Object{"instruction": "x"}); err == nil {
		t.Fatal("an invalid mandate must fail")
	}
}

func TestCanonicalMatchesTheJavaScriptForm(t *testing.T) {
	got, err := Canonical(Object{"terms": Object{"veg": true, "a&b": "<x>"}, "amount_paise": 56100, "item": "Masala dosa kit ₹"})
	want := `{"amount_paise":56100,"item":"Masala dosa kit ₹","terms":{"a&b":"<x>","veg":true}}`
	if err != nil || got != want {
		t.Fatalf("canonical:\n got %s\nwant %s", got, want)
	}
}

// A registered agent signs its checks, and gets the headers for a store that takes TheWavly.
func TestLiveRegisteredAgent(t *testing.T) {
	base, key := os.Getenv("WAVLY_TEST_BASE_URL"), os.Getenv("WAVLY_TEST_KEY")
	if base == "" || key == "" {
		t.Skip("set WAVLY_TEST_BASE_URL and WAVLY_TEST_KEY to run against a live TheWavly instance")
	}
	ctx := context.Background()
	admin, _ := New(key, WithBaseURL(base))
	handle := "go-agent-" + strconv.FormatInt(time.Now().UnixNano()%1e9, 10)
	if _, err := admin.Registry.Register(ctx, Object{"handle": handle, "name": "Go Agent", "website": "go-agent.in"}); err != nil {
		t.Fatal(err)
	}
	_, priv, _ := ed25519.GenerateKey(nil)
	k, err := admin.Registry.AddKey(ctx, handle, Object{"jwk": PublicJWK(priv)})
	if err != nil || k["kid"] != KeyID(priv) {
		t.Fatalf("the SDK must compute the same key id as TheWavly: %v %v", k["kid"], err)
	}
	agent, _ := New(key, WithBaseURL(base), WithAgent(handle, priv))
	m, _ := agent.Mandates.Create(ctx, Object{"instruction": "A kit up to ₹600", "approved_by": "go_user", "rules": Object{"items": []string{"Masala dosa kit"}, "max_amount_paise": 60000}})
	c, err := agent.Checks.Create(ctx, Object{"mandate": m["id"], "purchase": Object{"item": "Masala dosa kit", "amount_paise": 56100, "terms": Object{"veg": true}}})
	if err != nil || c["decision"] != "proceed" {
		t.Fatalf("check: %v %v", c["decision"], err)
	}
	v, _ := c["agent_verification"].(map[string]any)
	if v["status"] != "verified" || v["registry"] != true {
		t.Fatalf("the check must be signed by the registered agent: %v", v)
	}
	h, err := CheckoutHeaders(c, handle)
	if err != nil || h["Wavly-Agent"] != handle {
		t.Fatalf("headers: %v %v", h, err)
	}
	ans, err := VerifyOrder(ctx, base, handle, h["Wavly-Payment-Token"])
	if err != nil || ans["accept"] != false {
		t.Fatalf("an agent that has not proved its website is not accepted: %v %v", ans, err)
	}
	r, err := RedeemPaymentToken(ctx, base, h["Wavly-Payment-Token"], 56100, "", "GO-ORDER-1")
	if err != nil || r["status"] != "paid" {
		t.Fatalf("redeem: %v %v", r, err)
	}
	if _, err := RedeemPaymentToken(ctx, base, h["Wavly-Payment-Token"], 56100, "", "GO-ORDER-2"); err == nil {
		t.Fatal("a token pays once")
	}
	if _, err := CheckoutHeaders(Object{}, handle); err == nil {
		t.Fatal("a check without a token has no headers")
	}
}
