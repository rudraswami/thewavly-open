// Package wavly checks an AI agent's purchase against what the user approved, before it pays.
//
//	client, _ := wavly.New(os.Getenv("WAVLY_API_KEY"))
//	m, _ := client.Mandates.Create(ctx, wavly.Object{"instruction": "Buy Amma a saree for up to ₹2,500", "approved_by": "user_7f3",
//		"rules": wavly.Object{"items": []string{"Saree"}, "max_amount_paise": 250000}})
//	c, _ := client.Checks.Create(ctx, wavly.Object{"mandate": m["id"], "purchase": wavly.Object{"item": "Saree", "amount_paise": 249900}})
//	switch c["decision"] { case "proceed": /* pay */ case "ask": /* send c["approval"]["url"] */ default: /* do not pay */ }
//
// No dependencies beyond the standard library. Writes carry an Idempotency-Key, so a retried write is never applied twice.
package wavly

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// DefaultBaseURL is the hosted TheWavly API.
const DefaultBaseURL = "https://thewavly.com"

const userAgent = "wavly-go/0.1"

// Object is a JSON object, as sent to and returned by the API.
type Object = map[string]any

// Error is an error answer from the API.
type Error struct {
	Status    int
	Code      string
	Message   string
	Field     string
	RequestID string
}

func apiError(status int, data Object) *Error {
	apiErr := &Error{Status: status}
	if e, ok := data["error"].(map[string]any); ok {
		apiErr.Code, _ = e["code"].(string)
		apiErr.Message, _ = e["message"].(string)
		apiErr.Field, _ = e["field"].(string)
		apiErr.RequestID, _ = e["request_id"].(string)
	}
	return apiErr
}

func (e *Error) Error() string {
	s := fmt.Sprintf("wavly: %d %s: %s", e.Status, e.Code, e.Message)
	if e.Field != "" {
		s += " (" + e.Field + ")"
	}
	if e.RequestID != "" {
		s += " [request " + e.RequestID + "]"
	}
	return s
}

// Client calls TheWavly API with a secret key.
type Client struct {
	apiKey     string
	baseURL    string
	http       *http.Client
	maxRetries int
	agentID    string
	agentKey   ed25519.PrivateKey

	Mandates  *MandatesService
	Checks    *ChecksService
	Approvals *ApprovalsService
	Disputes  *DisputesService
	Registry  *RegistryService
}

// Option configures a Client.
type Option func(*Client)

// WithBaseURL points the client at another TheWavly deployment.
func WithBaseURL(u string) Option { return func(c *Client) { c.baseURL = strings.TrimRight(u, "/") } }

// WithHTTPClient sets the HTTP client, for example to change its timeout or transport.
func WithHTTPClient(h *http.Client) Option { return func(c *Client) { c.http = h } }

// WithMaxRetries sets how many times a request is retried after a network error, 429, 5xx or a busy answer. Default 2.
func WithMaxRetries(n int) Option { return func(c *Client) { c.maxRetries = n } }

// WithAgent gives the client the identity of an agent in TheWavly's public registry: its handle or id and its Ed25519
// private key. Every check then names the agent and is signed with its key, so it counts toward the agent's record.
func WithAgent(id string, key ed25519.PrivateKey) Option {
	return func(c *Client) { c.agentID, c.agentKey = id, key }
}

// New returns a client for a secret key (sk_test_… or sk_live_…).
func New(apiKey string, opts ...Option) (*Client, error) {
	if !strings.HasPrefix(apiKey, "sk_test_") && !strings.HasPrefix(apiKey, "sk_live_") {
		return nil, errors.New("wavly: needs a secret key that starts with sk_test_ or sk_live_")
	}
	c := &Client{apiKey: apiKey, baseURL: DefaultBaseURL, http: &http.Client{Timeout: 15 * time.Second}, maxRetries: 2}
	for _, o := range opts {
		o(c)
	}
	c.Mandates, c.Checks, c.Approvals, c.Disputes, c.Registry = &MandatesService{c}, &ChecksService{c}, &ApprovalsService{c}, &DisputesService{c}, &RegistryService{c}
	return c, nil
}

func newIdempotencyKey() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// Do sends one request and decodes the JSON answer. POSTs get an idempotency key unless one is given.
func (c *Client) Do(ctx context.Context, method, path string, body any, idempotencyKey string) (Object, error) {
	var payload []byte
	if body != nil {
		var err error
		if payload, err = json.Marshal(body); err != nil {
			return nil, err
		}
	}
	if method == http.MethodPost && idempotencyKey == "" {
		idempotencyKey = newIdempotencyKey()
	}
	for attempt := 0; ; attempt++ {
		req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, bytes.NewReader(payload))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Authorization", "Bearer "+c.apiKey)
		req.Header.Set("User-Agent", userAgent)
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		if idempotencyKey != "" {
			req.Header.Set("Idempotency-Key", idempotencyKey)
		}
		res, err := c.http.Do(req)
		if err != nil {
			if attempt < c.maxRetries && ctx.Err() == nil {
				if werr := wait(ctx, backoff(attempt, 0)); werr != nil {
					return nil, werr
				}
				continue
			}
			return nil, err
		}
		raw, _ := io.ReadAll(io.LimitReader(res.Body, 8<<20))
		res.Body.Close()
		var data Object
		_ = json.Unmarshal(raw, &data)
		if res.StatusCode >= 200 && res.StatusCode < 300 {
			return data, nil
		}
		apiErr := apiError(res.StatusCode, data)
		if apiErr.RequestID == "" {
			apiErr.RequestID = res.Header.Get("Request-Id")
		}
		retryable := res.StatusCode == 429 || res.StatusCode >= 500 || (res.StatusCode == 409 && apiErr.Code == "busy")
		if retryable && attempt < c.maxRetries {
			after, _ := strconv.Atoi(res.Header.Get("Retry-After"))
			if werr := wait(ctx, backoff(attempt, after)); werr != nil {
				return nil, werr
			}
			continue
		}
		return nil, apiErr
	}
}

func backoff(attempt, retryAfterSeconds int) time.Duration {
	d := time.Duration(400*math.Pow(2, float64(attempt))) * time.Millisecond
	if ra := time.Duration(retryAfterSeconds) * time.Second; ra > d {
		return ra
	}
	return d
}

func wait(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

func query(params map[string]string) string {
	v := url.Values{}
	for k, s := range params {
		if s != "" {
			v.Set(k, s)
		}
	}
	if len(v) == 0 {
		return ""
	}
	return "?" + v.Encode()
}

// MandatesService records what the user approved.
type MandatesService struct{ c *Client }

func (s *MandatesService) Create(ctx context.Context, params Object) (Object, error) {
	return s.c.Do(ctx, http.MethodPost, "/v1/mandates", params, "")
}
func (s *MandatesService) Retrieve(ctx context.Context, id string) (Object, error) {
	return s.c.Do(ctx, http.MethodGet, "/v1/mandates/"+url.PathEscape(id), nil, "")
}
func (s *MandatesService) List(ctx context.Context, params map[string]string) (Object, error) {
	return s.c.Do(ctx, http.MethodGet, "/v1/mandates"+query(params), nil, "")
}
func (s *MandatesService) Revoke(ctx context.Context, id string, params Object) (Object, error) {
	if params == nil {
		params = Object{}
	}
	return s.c.Do(ctx, http.MethodPost, "/v1/mandates/"+url.PathEscape(id)+"/revoke", params, "")
}

// ChecksService checks a purchase before payment: proceed, ask or stop.
type ChecksService struct{ c *Client }

// Create checks a purchase. With WithAgent, the check names the agent and is signed with its key (unless already signed).
func (s *ChecksService) Create(ctx context.Context, params Object) (Object, error) {
	if s.c.agentID != "" && params["agent_signature"] == nil {
		p := Object{}
		for k, v := range params {
			p[k] = v
		}
		if p["agent"] == nil {
			p["agent"] = s.c.agentID
		}
		if s.c.agentKey != nil {
			mandate, _ := p["mandate"].(string)
			sig, err := SignCheck(s.c.agentKey, mandate, p["purchase"])
			if err != nil {
				return nil, err
			}
			p["agent_signature"] = sig
		}
		params = p
	}
	return s.c.Do(ctx, http.MethodPost, "/v1/checks", params, "")
}

// PaymentToken issues a new single-use payment token for a check that may proceed, for example after the user approved.
func (s *ChecksService) PaymentToken(ctx context.Context, id string) (Object, error) {
	return s.c.Do(ctx, http.MethodPost, "/v1/checks/"+url.PathEscape(id)+"/payment_token", Object{}, "")
}
func (s *ChecksService) Retrieve(ctx context.Context, id string) (Object, error) {
	return s.c.Do(ctx, http.MethodGet, "/v1/checks/"+url.PathEscape(id), nil, "")
}
func (s *ChecksService) List(ctx context.Context, params map[string]string) (Object, error) {
	return s.c.Do(ctx, http.MethodGet, "/v1/checks"+query(params), nil, "")
}

// ReportOutcome records paid, failed or cancelled, so budgets stay right.
func (s *ChecksService) ReportOutcome(ctx context.Context, id string, params Object) (Object, error) {
	return s.c.Do(ctx, http.MethodPost, "/v1/checks/"+url.PathEscape(id)+"/outcome", params, "")
}

// Evidence returns the signed evidence pack for a check.
func (s *ChecksService) Evidence(ctx context.Context, id string) (Object, error) {
	return s.c.Do(ctx, http.MethodGet, "/v1/checks/"+url.PathEscape(id)+"/evidence", nil, "")
}

// ReportFulfilment records what happened to the order after payment: delivered, partially_delivered, not_delivered,
// returned, refunded (with amount_paise) or cancelled. Optional fields: party, items, amount_paise, occurred_at,
// carrier, tracking_reference, note.
func (s *ChecksService) ReportFulfilment(ctx context.Context, id string, body Object, idempotencyKey string) (Object, error) {
	return s.c.Do(ctx, http.MethodPost, "/v1/checks/"+url.PathEscape(id)+"/fulfilment", body, idempotencyKey)
}

// Fulfilment lists a check's fulfilment reports, oldest first.
func (s *ChecksService) Fulfilment(ctx context.Context, id string) (Object, error) {
	return s.c.Do(ctx, http.MethodGet, "/v1/checks/"+url.PathEscape(id)+"/fulfilment", nil, "")
}

// ApprovalsService reads the user's answer to an "ask".
type ApprovalsService struct{ c *Client }

func (s *ApprovalsService) Retrieve(ctx context.Context, id string) (Object, error) {
	return s.c.Do(ctx, http.MethodGet, "/v1/approvals/"+url.PathEscape(id), nil, "")
}

// DisputesService opens and follows disputes about agent purchases.
type DisputesService struct{ c *Client }

func (s *DisputesService) Create(ctx context.Context, params Object) (Object, error) {
	return s.c.Do(ctx, http.MethodPost, "/v1/disputes", params, "")
}
func (s *DisputesService) Retrieve(ctx context.Context, id string) (Object, error) {
	return s.c.Do(ctx, http.MethodGet, "/v1/disputes/"+url.PathEscape(id), nil, "")
}

// RegistryService registers agents in TheWavly's public registry, proves their websites and manages their keys.
type RegistryService struct{ c *Client }

func regPath(agent string) string { return "/v1/registry/agents/" + url.PathEscape(agent) }

func (s *RegistryService) Register(ctx context.Context, params Object) (Object, error) {
	return s.c.Do(ctx, http.MethodPost, "/v1/registry/agents", params, "")
}
func (s *RegistryService) Mine(ctx context.Context) (Object, error) {
	return s.c.Do(ctx, http.MethodGet, "/v1/registry/agents?mine=true", nil, "")
}
func (s *RegistryService) Retrieve(ctx context.Context, agent string) (Object, error) {
	return s.c.Do(ctx, http.MethodGet, regPath(agent), nil, "")
}
func (s *RegistryService) VerifyDomain(ctx context.Context, agent string) (Object, error) {
	return s.c.Do(ctx, http.MethodPost, regPath(agent)+"/verify", Object{}, "")
}
func (s *RegistryService) AddKey(ctx context.Context, agent string, params Object) (Object, error) {
	return s.c.Do(ctx, http.MethodPost, regPath(agent)+"/keys", params, "")
}
func (s *RegistryService) RevokeKey(ctx context.Context, agent, kid string) (Object, error) {
	return s.c.Do(ctx, http.MethodPost, regPath(agent)+"/keys/"+url.PathEscape(kid)+"/revoke", Object{}, "")
}

var b64u = base64.RawURLEncoding

// Canonical is JSON with object keys sorted and no HTML escaping, as TheWavly hashes a purchase for agent signatures.
func Canonical(v any) (string, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	// Round-trip through any so structs and typed maps become sorted maps
	raw, err := json.Marshal(v)
	if err != nil {
		return "", err
	}
	var generic any
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	if err := d.Decode(&generic); err != nil {
		return "", err
	}
	if err := enc.Encode(generic); err != nil {
		return "", err
	}
	return strings.TrimSuffix(buf.String(), "\n"), nil
}

// PublicJWK is the public half of an agent's Ed25519 key, as registered with Registry.AddKey.
func PublicJWK(key ed25519.PrivateKey) Object {
	return Object{"kty": "OKP", "crv": "Ed25519", "x": b64u.EncodeToString(key.Public().(ed25519.PublicKey))}
}

// KeyID is the RFC 7638 thumbprint TheWavly uses as the key id.
func KeyID(key ed25519.PrivateKey) string {
	sum := sha256.Sum256([]byte(`{"crv":"Ed25519","kty":"OKP","x":"` + b64u.EncodeToString(key.Public().(ed25519.PublicKey)) + `"}`))
	return b64u.EncodeToString(sum[:])
}

// SignCheck signs a check with the agent's Ed25519 key. Send it as agent_signature with exactly the same purchase.
func SignCheck(key ed25519.PrivateKey, mandate string, purchase any) (string, error) {
	c, err := Canonical(purchase)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256([]byte(c))
	header, _ := json.Marshal(map[string]string{"alg": "EdDSA", "kid": KeyID(key), "typ": "wavly-check+jws"})
	payload, _ := json.Marshal(map[string]any{"mandate": mandate, "purchase": b64u.EncodeToString(digest[:]), "iat": time.Now().Unix(), "jti": newIdempotencyKey()})
	input := b64u.EncodeToString(header) + "." + b64u.EncodeToString(payload)
	return input + "." + b64u.EncodeToString(ed25519.Sign(key, []byte(input))), nil
}

// CheckoutHeaders returns the headers a store that takes TheWavly reads: the agent's identity and the payment token.
func CheckoutHeaders(check Object, agent string) (map[string]string, error) {
	t, _ := check["payment_token"].(map[string]any)
	token, _ := t["token"].(string)
	if token == "" {
		return nil, errors.New("wavly: this check has no payment token; it may be paid only once its decision is proceed, or after the user approves")
	}
	if agent == "" {
		return nil, errors.New("wavly: CheckoutHeaders needs the agent's registry handle or id")
	}
	return map[string]string{"Wavly-Agent": agent, "Wavly-Payment-Token": token}, nil
}

// VerifyOrder is for merchants and needs no key: is this agent verified, and did its user approve this payment?
// Pass baseURL "" for the hosted API.
func VerifyOrder(ctx context.Context, baseURL, agent, paymentToken string) (Object, error) {
	return public(ctx, baseURL, "/v1/registry/verify", Object{"agent": agent, "payment_token": paymentToken})
}

// RedeemPaymentToken uses a payment token once, just before charging. Needs no key.
func RedeemPaymentToken(ctx context.Context, baseURL, token string, amountPaise int64, payee, paymentReference string) (Object, error) {
	body := Object{"token": token, "amount_paise": amountPaise, "payment_reference": paymentReference, "currency": "INR"}
	if payee != "" {
		body["payee"] = payee
	}
	return public(ctx, baseURL, "/v1/payment_tokens/redeem", body)
}

// ReportFulfilment, for the store or provider that redeemed the token, reports what happened to the order, proven with
// the release key the redemption returned. extra may hold items, amount_paise, carrier, tracking_reference, note.
func ReportFulfilment(ctx context.Context, baseURL, token, releaseKey, status string, extra Object) (Object, error) {
	body := Object{}
	for k, v := range extra {
		body[k] = v
	}
	body["token"], body["release_key"], body["status"] = token, releaseKey, status
	return public(ctx, baseURL, "/v1/payment_tokens/fulfilment", body)
}

func public(ctx context.Context, baseURL, path string, body Object) (Object, error) {
	if baseURL == "" {
		baseURL = DefaultBaseURL
	}
	raw, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(baseURL, "/")+path, bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", userAgent)
	res, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	var out Object
	_ = json.Unmarshal(data, &out)
	if res.StatusCode >= 300 {
		return nil, apiError(res.StatusCode, out)
	}
	return out, nil
}

var signatureHeader = regexp.MustCompile(`^t=(\d+),v1=([0-9a-f]{64})$`)

// VerifyWebhook checks a webhook's Wavly-Signature header against the endpoint's secret and returns the event.
// It fails if the signature does not match or the timestamp is more than tolerance away (default 5 minutes).
func VerifyWebhook(rawBody []byte, header, secret string, tolerance time.Duration) (Object, error) {
	if tolerance <= 0 {
		tolerance = 5 * time.Minute
	}
	m := signatureHeader.FindStringSubmatch(header)
	if m == nil {
		return nil, errors.New("wavly: missing or malformed Wavly-Signature header")
	}
	ts, _ := strconv.ParseInt(m[1], 10, 64)
	if d := time.Since(time.Unix(ts, 0)); d > tolerance || d < -tolerance {
		return nil, errors.New("wavly: webhook timestamp is outside the allowed window")
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(m[1] + "."))
	mac.Write(rawBody)
	want := hex.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(want), []byte(m[2])) {
		return nil, errors.New("wavly: webhook signature does not match")
	}
	var event Object
	if err := json.Unmarshal(rawBody, &event); err != nil {
		return nil, err
	}
	return event, nil
}
