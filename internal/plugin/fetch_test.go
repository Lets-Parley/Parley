package plugin

import (
	"context"
	"crypto/tls"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"testing"
)

// testFetcher points the guard at loopback test servers. Only the
// blocked-address screen is relaxed; the scheme check, the allowlist, the
// per-hop repetition and the address pinning all still run, which is what
// these tests are about.
func testFetcher(t *testing.T, hosts map[string]string) *Fetcher {
	t.Helper()
	return &Fetcher{
		allowBlockedAddresses: true,
		tlsConfig:             &tls.Config{InsecureSkipVerify: true}, //nolint:gosec // test servers use throwaway certificates
		resolve: func(_ context.Context, host string) ([]netip.Addr, error) {
			if _, ok := hosts[host]; !ok {
				return nil, &net.DNSError{Err: "no such host", Name: host, IsNotFound: true}
			}
			return []netip.Addr{netip.MustParseAddr("127.0.0.1")}, nil
		},
	}
}

// redirect writes a 302 without needing the request, which the handlers here
// do not have a use for.
func redirect(w http.ResponseWriter, to string) {
	w.Header().Set("Location", to)
	w.WriteHeader(http.StatusFound)
}

// serve starts an https test server and returns the "hostname:port" a plugin
// would name it by.
func serve(t *testing.T, h http.HandlerFunc) (*httptest.Server, string) {
	t.Helper()
	srv := httptest.NewTLSServer(h)
	t.Cleanup(srv.Close)
	u, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	return srv, u.Port()
}

func TestFetchRefusesEverySchemeButHTTPS(t *testing.T) {
	f := &Fetcher{}
	for _, target := range []string{"http://example.com/", "file:///etc/passwd", "gopher://example.com/"} {
		_, err := f.Do(context.Background(), []string{"example.com"}, FetchRequest{URL: target}, false)
		if !errors.Is(err, ErrFetchNotHTTPS) {
			t.Errorf("%s: got %v, want ErrFetchNotHTTPS", target, err)
		}
	}
}

func TestFetchRefusesAHostThatIsNotOnTheAllowlist(t *testing.T) {
	f := &Fetcher{}
	_, err := f.Do(context.Background(), []string{"api.example.com"}, FetchRequest{URL: "https://evil.example/"}, false)
	if !errors.Is(err, ErrFetchHostNotAllowed) {
		t.Fatalf("got %v, want ErrFetchHostNotAllowed", err)
	}
}

func TestAnAllowlistEntryTakesAtMostOneLeadingWildcard(t *testing.T) {
	good := []string{"example.com", "api.example.com", "*.example.com"}
	bad := []string{"", "*", "*.", "api.*.example.com", "example.*", "exa*mple.com", "localhost", "https://example.com", "example.com:443",
		// Outside the hostname alphabet. An embedded NUL certifies an entry no
		// host will ever match, which reads as a rule that matches something.
		"x.com\x00.evil.tld", "exam ple.com", "exa\tmple.com", "ex_ample.com", "café.com"}
	for _, p := range good {
		if err := ValidateAllowPattern(p); err != nil {
			t.Errorf("%q: got %v, want accepted", p, err)
		}
	}
	for _, p := range bad {
		if err := ValidateAllowPattern(p); !errors.Is(err, ErrAllowPattern) {
			t.Errorf("%q: got %v, want ErrAllowPattern", p, err)
		}
	}
}

func TestAWildcardEntryMatchesSubdomainsAndNotTheApexOrASuffixLookalike(t *testing.T) {
	patterns := []string{"*.example.com"}
	for _, host := range []string{"api.example.com", "a.b.example.com"} {
		if !hostAllowed(host, patterns) {
			t.Errorf("%q should match %v", host, patterns)
		}
	}
	for _, host := range []string{"example.com", "notexample.com", "example.com.evil.test"} {
		if hostAllowed(host, patterns) {
			t.Errorf("%q should not match %v", host, patterns)
		}
	}
}

func TestFetchRefusesPrivateLoopbackLinkLocalAndMetadataAddresses(t *testing.T) {
	blocked := []string{
		"127.0.0.1", "127.1.2.3", "0.0.0.0", "10.1.2.3", "172.16.5.4", "192.168.1.1",
		"169.254.169.254", "169.254.1.1", "100.64.3.2", "192.0.0.1", "198.18.0.1",
		"224.0.0.1", "240.0.0.1", "255.255.255.255",
		"::1", "::", "fe80::1", "fd00:ec2::254", "fc00::1", "ff02::1",
		"::ffff:169.254.169.254", "::ffff:127.0.0.1", "2002:a9fe:a9fe::1", "64:ff9b::a9fe:a9fe",
		// The IPv4-compatible form. Unmap does not fold these down, so they
		// reach the v6 arm still looking like ordinary v6 addresses.
		"::127.0.0.1", "::169.254.169.254", "::10.1.1.1",
	}
	for _, s := range blocked {
		if !blockedAddress(netip.MustParseAddr(s)) {
			t.Errorf("%s should be blocked", s)
		}
	}
	for _, s := range []string{"93.184.216.34", "1.1.1.1", "2606:2800:220:1:248:1893:25c8:1946"} {
		if blockedAddress(netip.MustParseAddr(s)) {
			t.Errorf("%s should be allowed", s)
		}
	}

	f := &Fetcher{resolve: func(context.Context, string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("169.254.169.254")}, nil
	}}
	_, err := f.Do(context.Background(), []string{"metadata.example.com"},
		FetchRequest{URL: "https://metadata.example.com/latest/meta-data/"}, false)
	if !errors.Is(err, ErrFetchBlockedAddress) {
		t.Fatalf("got %v, want ErrFetchBlockedAddress", err)
	}
}

func TestFetchScreensEveryResolvedRecordNotOnlyTheFirst(t *testing.T) {
	f := &Fetcher{resolve: func(context.Context, string) ([]netip.Addr, error) {
		return []netip.Addr{
			netip.MustParseAddr("93.184.216.34"),
			netip.MustParseAddr("169.254.169.254"),
		}, nil
	}}
	_, err := f.Do(context.Background(), []string{"rebind.example.com"},
		FetchRequest{URL: "https://rebind.example.com/"}, false)
	if !errors.Is(err, ErrFetchBlockedAddress) {
		t.Fatalf("a public record alongside a metadata record must fail the whole request; got %v", err)
	}
}

func TestFetchDialsTheScreenedAddressRatherThanTheHostname(t *testing.T) {
	// The resolver answers once with a loopback address and then, as a
	// rebinding attacker's would, with the metadata address. Only the first
	// answer was screened, and it is the one that must be dialled.
	srv, port := serve(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	})
	_ = srv

	calls := 0
	f := testFetcher(t, map[string]string{"pinned.example.com": ""})
	f.resolve = func(context.Context, string) ([]netip.Addr, error) {
		calls++
		if calls == 1 {
			return []netip.Addr{netip.MustParseAddr("127.0.0.1")}, nil
		}
		return []netip.Addr{netip.MustParseAddr("169.254.169.254")}, nil
	}

	resp, err := f.Do(context.Background(), []string{"pinned.example.com"},
		FetchRequest{URL: "https://pinned.example.com:" + port + "/"}, false)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Status != http.StatusTeapot {
		t.Fatalf("status %d, want %d — the guard did not dial the address it screened", resp.Status, http.StatusTeapot)
	}
	if calls != 1 {
		t.Fatalf("the guard resolved %d times for one hop; it must dial the address it screened", calls)
	}
}

func TestEveryRedirectHopRepeatsTheWholeSequence(t *testing.T) {
	_, offPort := serve(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("secrets"))
	})

	t.Run("the allowlist is rechecked on the hop", func(t *testing.T) {
		var toOff string
		_, port := serve(t, func(w http.ResponseWriter, _ *http.Request) {
			redirect(w, toOff)
		})
		toOff = "https://off.example.com:" + offPort + "/"
		f := testFetcher(t, map[string]string{"start.example.com": "", "off.example.com": ""})
		_, err := f.Do(context.Background(), []string{"start.example.com"},
			FetchRequest{URL: "https://start.example.com:" + port + "/"}, false)
		if !errors.Is(err, ErrFetchHostNotAllowed) {
			t.Fatalf("got %v, want ErrFetchHostNotAllowed", err)
		}
	})

	t.Run("the address screen is rechecked on the hop", func(t *testing.T) {
		// The redirect target is on the allowlist, so only the address screen
		// can stop it. The first hop needs the loopback relaxation to reach
		// the test server; the second hop must not get it.
		_, port := serve(t, func(w http.ResponseWriter, _ *http.Request) {
			redirect(w, "https://metadata.example.com/latest/meta-data/")
		})
		f := testFetcher(t, nil)
		f.resolve = func(_ context.Context, host string) ([]netip.Addr, error) {
			if host == "start.example.com" {
				return []netip.Addr{netip.MustParseAddr("127.0.0.1")}, nil
			}
			f.allowBlockedAddresses = false
			return []netip.Addr{netip.MustParseAddr("169.254.169.254")}, nil
		}
		_, err := f.Do(context.Background(), []string{"start.example.com", "metadata.example.com"},
			FetchRequest{URL: "https://start.example.com:" + port + "/"}, false)
		if !errors.Is(err, ErrFetchBlockedAddress) {
			t.Fatalf("got %v, want ErrFetchBlockedAddress", err)
		}
	})

	t.Run("the scheme is rechecked on the hop", func(t *testing.T) {
		_, port := serve(t, func(w http.ResponseWriter, _ *http.Request) {
			redirect(w, "http://start.example.com/plain")
		})
		f := testFetcher(t, map[string]string{"start.example.com": ""})
		_, err := f.Do(context.Background(), []string{"start.example.com"},
			FetchRequest{URL: "https://start.example.com:" + port + "/"}, false)
		if !errors.Is(err, ErrFetchNotHTTPS) {
			t.Fatalf("got %v, want ErrFetchNotHTTPS", err)
		}
	})

	t.Run("the hop budget is bounded", func(t *testing.T) {
		var self string
		_, port := serve(t, func(w http.ResponseWriter, _ *http.Request) {
			redirect(w, self)
		})
		self = "https://start.example.com:" + port + "/loop"
		f := testFetcher(t, map[string]string{"start.example.com": ""})
		f.MaxRedirects = 2
		_, err := f.Do(context.Background(), []string{"start.example.com"},
			FetchRequest{URL: self}, false)
		if !errors.Is(err, ErrFetchTooManyRedirects) {
			t.Fatalf("got %v, want ErrFetchTooManyRedirects", err)
		}
	})
}

func TestASynchronousHookCannotFetchEvenWithTheGrant(t *testing.T) {
	_, port := serve(t, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	f := testFetcher(t, map[string]string{"start.example.com": ""})
	_, err := f.Do(context.Background(), []string{"start.example.com"},
		FetchRequest{URL: "https://start.example.com:" + port + "/"}, true)
	if !errors.Is(err, ErrFetchSynchronousHook) {
		t.Fatalf("got %v, want ErrFetchSynchronousHook", err)
	}
}

func TestCredentialsDoNotFollowARedirectToAnotherHost(t *testing.T) {
	// The victim is what the plugin's headers were for; the attacker is where
	// a 3xx sends them. Both are inside one allowlist entry, so nothing else
	// in the guard stops this: only the header strip does.
	var got http.Header
	_, attackerPort := serve(t, func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Clone()
		w.WriteHeader(http.StatusOK)
	})
	var toAttacker string
	_, victimPort := serve(t, func(w http.ResponseWriter, _ *http.Request) { redirect(w, toAttacker) })
	toAttacker = "https://attacker.example.com:" + attackerPort + "/"

	f := testFetcher(t, map[string]string{"api.example.com": "", "attacker.example.com": ""})
	_, err := f.Do(context.Background(), []string{"*.example.com"}, FetchRequest{
		URL: "https://api.example.com:" + victimPort + "/",
		Headers: map[string]string{
			"Authorization":       "Bearer TOPSECRET",
			"Cookie":              "sid=abc",
			"Cookie2":             "sid2=def",
			"Proxy-Authorization": "Basic ZGVhZDpiZWVm",
			"Www-Authenticate":    "Basic realm=\"plugin\"",
			"X-Plugin-Trace":      "keep-me",
		},
	}, false)
	if err != nil {
		t.Fatal(err)
	}
	for _, h := range []string{"Authorization", "Cookie", "Cookie2", "Proxy-Authorization", "Www-Authenticate"} {
		if v := got.Get(h); v != "" {
			t.Errorf("the host on the far side of the redirect received %s: %q", h, v)
		}
	}
	// A header that is not a credential still travels, because stripping
	// everything would break a plugin that sets an Accept header.
	if v := got.Get("X-Plugin-Trace"); v != "keep-me" {
		t.Errorf("X-Plugin-Trace is %q; only the credential headers should be dropped", v)
	}
}

func TestCredentialsSurviveARedirectBackToTheSameHost(t *testing.T) {
	var got http.Header
	var self string
	_, port := serve(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/moved" {
			redirect(w, self)
			return
		}
		got = r.Header.Clone()
		w.WriteHeader(http.StatusOK)
	})
	self = "https://api.example.com:" + port + "/final"

	f := testFetcher(t, map[string]string{"api.example.com": ""})
	_, err := f.Do(context.Background(), []string{"api.example.com"}, FetchRequest{
		URL:     "https://api.example.com:" + port + "/moved",
		Headers: map[string]string{"Authorization": "Bearer TOPSECRET"},
	}, false)
	if err != nil {
		t.Fatal(err)
	}
	if got.Get("Authorization") != "Bearer TOPSECRET" {
		t.Fatalf("Authorization is %q on a same-host redirect; it should survive", got.Get("Authorization"))
	}
}
