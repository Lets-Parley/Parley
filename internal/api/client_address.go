package api

import (
	"net/http"
	"net/netip"
	"strings"
)

func trustedProxyHeaders(trusted []netip.Prefix) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			peer, ok := parseClientAddress(r.RemoteAddr)
			if !ok || !addressInPrefixes(peer, trusted) {
				next.ServeHTTP(w, r)
				return
			}

			values := r.Header.Values("X-Forwarded-For")
			if len(values) != 1 {
				next.ServeHTTP(w, r)
				return
			}
			xff := strings.TrimSpace(values[0])
			if xff == "" {
				next.ServeHTTP(w, r)
				return
			}
			parts := strings.Split(xff, ",")
			chain := make([]netip.Addr, len(parts))
			for i, part := range parts {
				addr, ok := parseClientAddress(strings.TrimSpace(part))
				if !ok {
					next.ServeHTTP(w, r)
					return
				}
				chain[i] = addr
			}

			for i := len(chain) - 1; i >= 0; i-- {
				if !addressInPrefixes(chain[i], trusted) {
					r.RemoteAddr = chain[i].String()
					break
				}
			}
			next.ServeHTTP(w, r)
		})
	}
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
