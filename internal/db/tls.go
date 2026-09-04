package db

import (
	"fmt"
	"net/url"
	"os"
	"sort"
	"strings"
)

// TLSSettings reports the sslmode a DATABASE_URL will actually connect with,
// and the sslrootcert it would verify the server against.
//
// pgx does not default sslmode to anything visible: an absent parameter means
// "prefer", which negotiates TLS if the server offers it and silently falls
// back to plaintext if it does not. Resolving that default here is the whole
// reason a caller can refuse it.
//
// A repeated parameter is refused rather than resolved. pgx's own parser keeps
// the FIRST value of a duplicated URL key while a reader (and this function's
// earlier form) naturally keeps the last, so a string like
// "?sslmode=disable&sslmode=verify-full" would let this check pass on
// verify-full while the driver connected in the clear. There is no safe choice
// to make on the operator's behalf, so the boot stops and names the key.
func TLSSettings(databaseURL string) (mode, rootCert string, err error) {
	params := map[string]string{}
	var duplicates []string
	if u, parseErr := url.Parse(databaseURL); parseErr == nil && u.Scheme != "" {
		for key, values := range u.Query() {
			if len(values) > 1 {
				duplicates = append(duplicates, key)
				continue
			}
			if len(values) > 0 {
				params[key] = values[0]
			}
		}
	} else {
		// The keyword/value form: "host=db user=parley sslmode=require".
		for _, field := range strings.Fields(databaseURL) {
			if key, value, ok := strings.Cut(field, "="); ok {
				if _, seen := params[key]; seen {
					duplicates = append(duplicates, key)
					continue
				}
				params[key] = value
			}
		}
	}
	if len(duplicates) > 0 {
		sort.Strings(duplicates)
		return "", "", fmt.Errorf("DATABASE_URL sets %s more than once — the driver and this check would not agree on which value wins, so the connection's encryption cannot be established. Remove the duplicate", strings.Join(quoteAll(duplicates), ", "))
	}

	mode = params["sslmode"]
	if mode == "" {
		mode = os.Getenv("PGSSLMODE")
	}
	if mode == "" {
		mode = "prefer"
	}
	rootCert = params["sslrootcert"]
	if rootCert == "" {
		rootCert = os.Getenv("PGSSLROOTCERT")
	}
	return strings.ToLower(strings.TrimSpace(mode)), strings.TrimSpace(rootCert), nil
}

func quoteAll(keys []string) []string {
	quoted := make([]string, len(keys))
	for i, key := range keys {
		quoted[i] = fmt.Sprintf("%q", key)
	}
	return quoted
}

// CheckTLS refuses an sslmode that can end up talking to Postgres in the clear.
// allowPlaintext is the operator's explicit acceptance of that risk.
func CheckTLS(mode string, allowPlaintext bool) error {
	switch mode {
	case "disable", "allow", "prefer":
		if !allowPlaintext {
			return fmt.Errorf("DATABASE_URL resolves to sslmode=%s, which lets Parley talk to Postgres in the clear — passcodes, story notes and session data would cross the network unencrypted. Add ?sslmode=verify-full&sslrootcert=/path/to/ca.pem to DATABASE_URL, or set DATABASE_ALLOW_PLAINTEXT=true if the database is only reachable over a link you already trust", mode)
		}
	case "require", "verify-ca", "verify-full":
	default:
		return fmt.Errorf("DATABASE_URL sslmode=%q is not one of disable, allow, prefer, require, verify-ca, verify-full", mode)
	}
	return nil
}
