package plugin

import (
	"bytes"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"
)

// Why the guard is shaped like this
//
// A plugin has no sockets. Every byte it sends leaves through this function,
// which is the only reason a capability grant means anything: an allowlist a
// plugin could route around would be decoration.
//
// The classic bypass is to check the name and then dial the name. Between the
// check and the dial the resolver is free to answer differently, so the guard
// resolves once, screens *every* record it got back, and then dials the
// address it screened rather than the hostname. A redirect restarts the whole
// sequence — scheme, allowlist, resolution, screening — because a redirect is
// a new request to a host nobody has checked yet.

// Blocked reasons. Each fixture asserts one of these by identity, so a guard
// that stops working fails a specific assertion rather than a vague one.
var (
	// ErrFetchNotHTTPS is returned for any scheme but https.
	ErrFetchNotHTTPS = errors.New("fetch refused: only https is allowed")
	// ErrFetchHostNotAllowed is returned when the host is not on the install's
	// allowlist.
	ErrFetchHostNotAllowed = errors.New("fetch refused: the host is not on this plugin's allowlist")
	// ErrFetchBlockedAddress is returned when the host resolves to an address
	// on the internal network, the loopback, the link-local range, or a cloud
	// metadata endpoint.
	ErrFetchBlockedAddress = errors.New("fetch refused: the host resolves to a blocked address")
	// ErrFetchNoAddress is returned when the host resolves to nothing usable.
	ErrFetchNoAddress = errors.New("fetch refused: the host resolves to no usable address")
	// ErrFetchTooManyRedirects is returned when the hop budget runs out.
	ErrFetchTooManyRedirects = errors.New("fetch refused: too many redirects")
	// ErrFetchSynchronousHook is returned when anything but an asynchronous
	// call tries to fetch — a synchronous hook, or a call whose mode never
	// arrived. Grants do not enter into it: a hook runs on the path a room's
	// state broadcast waits on, so it may not wait on the network. Remote data
	// reaches a hook from a cache a job filled.
	ErrFetchSynchronousHook = errors.New("fetch refused: a synchronous hook cannot reach the network; read a cache a job filled")
	// ErrAllowPattern is returned for an allowlist entry that is not a
	// hostname with at most one leading wildcard label.
	ErrAllowPattern = errors.New("an allowlist entry must be a hostname, optionally with a single leading \"*.\" label")
)

// Defaults for the fetch guard.
const (
	DefaultFetchRedirects = 5
	DefaultFetchBodyBytes = 1 << 20
	DefaultFetchTimeout   = 10 * time.Second
)

// FetchRequest is what a plugin asks the host to send.
type FetchRequest struct {
	Method  string            `json:"method"`
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers,omitempty"`
	Body    []byte            `json:"body,omitempty"`
}

// FetchResponse is what comes back. The body is capped; a plugin cannot pull
// an arbitrary amount of memory into the process through a fetch.
type FetchResponse struct {
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers,omitempty"`
	Body    []byte            `json:"body,omitempty"`
}

// Fetcher performs guarded outbound requests on behalf of plugins.
type Fetcher struct {
	MaxRedirects int
	MaxBodyBytes int64
	Timeout      time.Duration

	// resolve looks a hostname up. Tests replace it; nothing outside this
	// package can.
	resolve func(ctx context.Context, host string) ([]netip.Addr, error)
	// allowBlockedAddresses lets an in-package test point the guard at a
	// loopback test server. It is unexported and has no configuration knob,
	// because an operator-settable "allow internal addresses" flag is the
	// hole this whole file exists to close.
	allowBlockedAddresses bool
	// tlsConfig is test-only for the same reason.
	tlsConfig *tls.Config
}

func (f *Fetcher) redirects() int { return orDefaultInt(f.MaxRedirects, DefaultFetchRedirects) }

func (f *Fetcher) bodyLimit() int64 {
	if f.MaxBodyBytes > 0 {
		return f.MaxBodyBytes
	}
	return DefaultFetchBodyBytes
}

func (f *Fetcher) lookup(ctx context.Context, host string) ([]netip.Addr, error) {
	if f.resolve != nil {
		return f.resolve(ctx, host)
	}
	return net.DefaultResolver.LookupNetIP(ctx, "ip", host)
}

// ValidateAllowPattern rejects an allowlist entry the guard could not enforce
// honestly. Exactly one leading wildcard label is allowed, because a pattern
// with a wildcard anywhere else ("api.*.example.com", or a bare "*") reads as
// narrower than it matches.
func ValidateAllowPattern(pattern string) error {
	p := strings.ToLower(strings.TrimSpace(pattern))
	if p == "" {
		return fmt.Errorf("%q: %w", pattern, ErrAllowPattern)
	}
	if rest, ok := strings.CutPrefix(p, "*."); ok {
		p = rest
	}
	if p == "" || strings.HasPrefix(p, ".") || strings.HasSuffix(p, ".") ||
		!strings.Contains(p, ".") {
		return fmt.Errorf("%q: %w", pattern, ErrAllowPattern)
	}
	// The alphabet, not a list of the characters that have caused trouble so
	// far. An entry outside it — a NUL, a space, a slash, a colon, a second
	// wildcard — cannot be a hostname, so certifying it would bless a rule no
	// host will ever match while reading like a rule that matches something.
	for i := range len(p) {
		c := p[i]
		if (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '.' {
			continue
		}
		return fmt.Errorf("%q: %w", pattern, ErrAllowPattern)
	}
	return nil
}

func allZero(b []byte) bool {
	for _, c := range b {
		if c != 0 {
			return false
		}
	}
	return true
}

// hostAllowed reports whether host matches any pattern. A "*.example.com"
// entry matches subdomains of example.com but not example.com itself, so an
// operator who means both writes both.
func hostAllowed(host string, patterns []string) bool {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	for _, pattern := range patterns {
		p := strings.ToLower(strings.TrimSpace(pattern))
		if suffix, ok := strings.CutPrefix(p, "*."); ok {
			if strings.HasSuffix(host, "."+suffix) && len(host) > len(suffix)+1 {
				return true
			}
			continue
		}
		if host == p {
			return true
		}
	}
	return false
}

// blockedAddress screens one resolved record. Everything that is not a public
// unicast address is blocked, and the ranges that route to somewhere sensitive
// on a normal deployment — the loopback, RFC 1918, carrier-grade NAT, the
// link-local range every cloud parks its metadata service in, unique-local
// v6 — are named explicitly rather than left to IsGlobalUnicast.
func blockedAddress(a netip.Addr) bool {
	a = a.Unmap()
	if !a.IsValid() {
		return true
	}
	if a.IsLoopback() || a.IsUnspecified() || a.IsPrivate() ||
		a.IsLinkLocalUnicast() || a.IsLinkLocalMulticast() ||
		a.IsMulticast() || a.IsInterfaceLocalMulticast() || !a.IsGlobalUnicast() {
		return true
	}
	if a.Is4() {
		b := a.As4()
		switch {
		case b[0] == 0: // 0.0.0.0/8, "this network"
			return true
		case b[0] == 100 && b[1]&0xc0 == 64: // 100.64.0.0/10, carrier-grade NAT
			return true
		case b[0] == 192 && b[1] == 0 && b[2] == 0: // 192.0.0.0/24, IETF protocol assignments
			return true
		case b[0] == 198 && b[1]&0xfe == 18: // 198.18.0.0/15, benchmarking
			return true
		case b[0] >= 240: // 240.0.0.0/4, reserved
			return true
		}
		return false
	}
	b := a.As16()
	switch {
	case b[0]&0xfe == 0xfc: // fc00::/7, unique local — where AWS parks fd00:ec2::254
		return true
	case b[0] == 0x20 && b[1] == 0x02: // 2002::/16, 6to4 — screen the embedded v4
		return blockedAddress(netip.AddrFrom4([4]byte{b[2], b[3], b[4], b[5]}))
	case b[0] == 0x00 && b[1] == 0x64 && b[2] == 0xff && b[3] == 0x9b: // 64:ff9b::/96, NAT64
		return blockedAddress(netip.AddrFrom4([4]byte{b[12], b[13], b[14], b[15]}))
	case allZero(b[:12]): // ::/96, IPv4-compatible — screen the embedded v4
		// Unmap has already folded the ::ffff: form down to a v4 address, so
		// what reaches here is the compatible form: "::169.254.169.254" is
		// still the metadata service, and a stack that routes it gets there.
		return blockedAddress(netip.AddrFrom4([4]byte{b[12], b[13], b[14], b[15]}))
	}
	return false
}

// screen resolves a host and returns the address to dial, having checked every
// record. One bad record fails the whole request: a name that answers with a
// public address and a metadata address is a rebinding attempt, not a
// multi-homed service.
func (f *Fetcher) screen(ctx context.Context, host string) (netip.Addr, error) {
	if literal, err := netip.ParseAddr(host); err == nil {
		if blockedAddress(literal) && !f.allowBlockedAddresses {
			return netip.Addr{}, fmt.Errorf("%s: %w", host, ErrFetchBlockedAddress)
		}
		return literal, nil
	}
	addrs, err := f.lookup(ctx, host)
	if err != nil {
		return netip.Addr{}, fmt.Errorf("resolving %s: %w", host, err)
	}
	if len(addrs) == 0 {
		return netip.Addr{}, fmt.Errorf("%s: %w", host, ErrFetchNoAddress)
	}
	for _, a := range addrs {
		if blockedAddress(a) && !f.allowBlockedAddresses {
			return netip.Addr{}, fmt.Errorf("%s resolves to %s: %w", host, a, ErrFetchBlockedAddress)
		}
	}
	return addrs[0].Unmap(), nil
}

// Do performs one guarded request, following redirects by hand so that every
// hop goes through the same checks the first one did.
//
// sync is true when the call is a synchronous hook, and no grant makes a fetch
// legal there.
func (f *Fetcher) Do(ctx context.Context, allow []string, req FetchRequest, sync bool) (*FetchResponse, error) {
	if sync {
		return nil, ErrFetchSynchronousHook
	}
	timeout := f.Timeout
	if timeout <= 0 {
		timeout = DefaultFetchTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	method := strings.ToUpper(strings.TrimSpace(req.Method))
	if method == "" {
		method = http.MethodGet
	}
	target := req.URL
	var firstHost string
	for hop := 0; ; hop++ {
		if hop > f.redirects() {
			return nil, ErrFetchTooManyRedirects
		}
		u, err := url.Parse(target)
		if err != nil {
			return nil, fmt.Errorf("parsing %q: %w", target, err)
		}
		// Scheme, then allowlist, then resolution, then screening — for this
		// hop, not for the one the plugin originally named.
		if !strings.EqualFold(u.Scheme, "https") {
			return nil, fmt.Errorf("%s: %w", u.Scheme, ErrFetchNotHTTPS)
		}
		if !hostAllowed(u.Hostname(), allow) {
			return nil, fmt.Errorf("%s: %w", u.Hostname(), ErrFetchHostNotAllowed)
		}
		pinned, err := f.screen(ctx, u.Hostname())
		if err != nil {
			return nil, err
		}

		// Which host the plugin's credentials were addressed to. A redirect to
		// any other one travels without them.
		host := strings.ToLower(u.Hostname())
		if hop == 0 {
			firstHost = host
		}

		resp, err := f.send(ctx, method, u, pinned, req, hop == 0, host == firstHost)
		if err != nil {
			return nil, err
		}
		if location := redirectTarget(resp); location != "" {
			resp.Body.Close()
			next, err := u.Parse(location)
			if err != nil {
				return nil, fmt.Errorf("parsing the redirect target %q: %w", location, err)
			}
			target = next.String()
			if resp.StatusCode == http.StatusSeeOther || (method != http.MethodHead && method != http.MethodGet &&
				(resp.StatusCode == http.StatusMovedPermanently || resp.StatusCode == http.StatusFound)) {
				method = http.MethodGet
			}
			continue
		}
		defer resp.Body.Close()

		body, err := io.ReadAll(io.LimitReader(resp.Body, f.bodyLimit()))
		if err != nil {
			return nil, fmt.Errorf("reading the response body: %w", err)
		}
		headers := map[string]string{}
		for k := range resp.Header {
			headers[strings.ToLower(k)] = resp.Header.Get(k)
		}
		return &FetchResponse{Status: resp.StatusCode, Headers: headers, Body: body}, nil
	}
}

func redirectTarget(resp *http.Response) string {
	switch resp.StatusCode {
	case http.StatusMovedPermanently, http.StatusFound, http.StatusSeeOther,
		http.StatusTemporaryRedirect, http.StatusPermanentRedirect:
		return resp.Header.Get("Location")
	}
	return ""
}

// sensitiveHeaders are the headers net/http refuses to carry across a
// redirect to another host. This guard follows redirects by hand, so it has to
// make the same refusal itself: without it a plugin's credential for one host
// is delivered to whatever host that one chooses to 302 to, which turns an
// allowlist entry an operator approved into a way to reach a host they did
// not.
var sensitiveHeaders = map[string]bool{
	"Authorization":       true,
	"Cookie":              true,
	"Cookie2":             true,
	"Proxy-Authorization": true,
	"Www-Authenticate":    true,
}

// send dials the screened address. The transport is built per hop and its
// dialler ignores the hostname entirely: whatever the resolver would say now,
// the connection goes to the address that was screened a moment ago.
//
// sameHost is false once a redirect has moved the request off the host the
// plugin named, and the credential headers are dropped when it is.
func (f *Fetcher) send(ctx context.Context, method string, u *url.URL, pinned netip.Addr, req FetchRequest, firstHop, sameHost bool) (*http.Response, error) {
	port := u.Port()
	if port == "" {
		port = "443"
	}
	dialTo := net.JoinHostPort(pinned.String(), port)

	transport := &http.Transport{
		TLSClientConfig:     f.tlsConfig,
		DisableKeepAlives:   true,
		TLSHandshakeTimeout: 10 * time.Second,
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			// Screened once above; screened again here, because this is the
			// last place the address can still be wrong.
			if blockedAddress(pinned) && !f.allowBlockedAddresses {
				return nil, fmt.Errorf("%s: %w", pinned, ErrFetchBlockedAddress)
			}
			return (&net.Dialer{Timeout: 10 * time.Second}).DialContext(ctx, network, dialTo)
		},
	}
	defer transport.CloseIdleConnections()

	var body io.Reader
	if firstHop && len(req.Body) > 0 && method != http.MethodGet && method != http.MethodHead {
		body = bytes.NewReader(req.Body)
	}
	httpReq, err := http.NewRequestWithContext(ctx, method, u.String(), body)
	if err != nil {
		return nil, fmt.Errorf("building the request: %w", err)
	}
	for k, v := range req.Headers {
		if !sameHost && sensitiveHeaders[http.CanonicalHeaderKey(k)] {
			continue
		}
		httpReq.Header.Set(k, v)
	}

	client := &http.Client{
		Transport:     transport,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	resp, err := client.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("fetching %s: %w", u.Redacted(), err)
	}
	return resp, nil
}
