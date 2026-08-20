package api

import (
	"log/slog"
	"net/http"
	"net/netip"
	"strings"
)

func trustedProxyHeaders(trusted []netip.Prefix, log *slog.Logger) func(http.Handler) http.Handler {
	if log == nil {
		log = slog.Default()
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			peer := r.RemoteAddr
			peerTrusted, chain, resolved := resolveForwarded(r, trusted)
			if resolved != "" {
				r.RemoteAddr = resolved
			}
			// Off unless LOG_LEVEL=debug, and deliberately narrow. The three
			// fields below are the whole allow-list: the socket peer, the
			// forwarded chain, and what the two of them resolved to. Nothing
			// else about the request — no headers, no cookie, no token — is
			// ever written here, because this log exists to diagnose a proxy
			// and diagnosing a proxy never needs a credential.
			log.DebugContext(r.Context(), "client address resolved",
				"peer", peer,
				"peer_trusted", peerTrusted,
				"forwarded_for", chain,
				"resolved", r.RemoteAddr,
			)
			next.ServeHTTP(w, r)
		})
	}
}

// resolveForwarded reports whether the socket peer was a trusted proxy, the
// forwarded chain it presented, and the address to rewrite RemoteAddr to. An
// empty resolved address means "leave RemoteAddr alone" — an untrusted peer, a
// missing, duplicated, empty or malformed header, or a chain that is trusted
// all the way down.
func resolveForwarded(r *http.Request, trusted []netip.Prefix) (bool, []string, string) {
	peer, ok := parseClientAddress(r.RemoteAddr)
	if !ok || !addressInPrefixes(peer, trusted) {
		return false, nil, ""
	}

	values := r.Header.Values("X-Forwarded-For")
	if len(values) != 1 {
		return true, nil, ""
	}
	xff := strings.TrimSpace(values[0])
	if xff == "" {
		return true, nil, ""
	}
	parts := strings.Split(xff, ",")
	chain := make([]netip.Addr, len(parts))
	text := make([]string, len(parts))
	for i, part := range parts {
		addr, ok := parseClientAddress(strings.TrimSpace(part))
		if !ok {
			return true, nil, ""
		}
		chain[i] = addr
		text[i] = addr.String()
	}

	for i := len(chain) - 1; i >= 0; i-- {
		if !addressInPrefixes(chain[i], trusted) {
			return true, text, chain[i].String()
		}
	}
	return true, text, ""
}

func parseClientAddress(value string) (netip.Addr, bool) {
	value = strings.TrimSpace(value)
	if addr, err := netip.ParseAddr(value); err == nil {
		return normalizeAddress(addr), true
	}
	addrPort, err := netip.ParseAddrPort(value)
	if err != nil {
		return netip.Addr{}, false
	}
	return normalizeAddress(addrPort.Addr()), true
}

func normalizeAddress(addr netip.Addr) netip.Addr {
	addr = addr.Unmap()
	if addr.Is6() {
		addr = addr.WithZone("")
	}
	return addr
}

func addressInPrefixes(addr netip.Addr, prefixes []netip.Prefix) bool {
	addr = addr.Unmap()
	for _, prefix := range prefixes {
		if prefix.Addr().Is4In6() && prefix.Bits() >= 96 {
			prefix = netip.PrefixFrom(prefix.Addr().Unmap(), prefix.Bits()-96)
		}
		if prefix.Contains(addr) {
			return true
		}
	}
	return false
}
