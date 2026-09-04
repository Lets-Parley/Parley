package db

import (
	"fmt"
	"net/url"
	"os"
	"strings"
)

// TLSSettings reports the sslmode a DATABASE_URL will actually connect with,
// and the sslrootcert it would verify the server against.
//
// pgx does not default sslmode to anything visible: an absent parameter means
// "prefer", which negotiates TLS if the server offers it and silently falls
// back to plaintext if it does not. Resolving that default here is the whole
// reason a caller can refuse it.
func TLSSettings(databaseURL string) (mode, rootCert string) {
	params := map[string]string{}
	if u, err := url.Parse(databaseURL); err == nil && u.Scheme != "" {
		for key, values := range u.Query() {
			if len(values) > 0 {
				params[key] = values[len(values)-1]
			}
		}
	} else {
		// The keyword/value form: "host=db user=parley sslmode=require".
		for _, field := range strings.Fields(databaseURL) {
			if key, value, ok := strings.Cut(field, "="); ok {
				params[key] = value
			}
		}
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
	return strings.ToLower(strings.TrimSpace(mode)), strings.TrimSpace(rootCert)
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
