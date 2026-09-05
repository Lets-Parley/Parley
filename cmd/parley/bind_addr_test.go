package main

import (
	"strings"
	"testing"
)

func TestListenAddrJoinsBindAndPort(t *testing.T) {
	cases := []struct {
		bind, port, want string
	}{
		{"", "8080", ":8080"},
		{"127.0.0.1", "8080", "127.0.0.1:8080"},
		{"10.0.0.5", "9090", "10.0.0.5:9090"},
		{"localhost", "8080", "localhost:8080"},
		{"::1", "8080", "[::1]:8080"},
		{"[::1]", "8080", "[::1]:8080"},
	}
	for _, tc := range cases {
		if got := listenAddr(tc.bind, tc.port); got != tc.want {
			t.Errorf("listenAddr(%q, %q) = %q, want %q", tc.bind, tc.port, got, tc.want)
		}
	}
}

func TestLoadConfigRefusesBindAddrWithAPort(t *testing.T) {
	for _, bind := range []string{"1.2.3.4:80", "[::1]:80"} {
		t.Run(bind, func(t *testing.T) {
			baseConfigEnv(t)
			t.Setenv("BIND_ADDR", bind)
			_, err := loadConfig()
			if err == nil {
				t.Fatalf("BIND_ADDR=%s was accepted", bind)
			}
			msg := err.Error()
			if !strings.Contains(msg, "BIND_ADDR") {
				t.Errorf("error %q does not name BIND_ADDR", msg)
			}
			if !strings.Contains(msg, "PORT") {
				t.Errorf("error %q does not name PORT", msg)
			}
		})
	}
}

func TestLoadConfigAcceptsABareBindAddr(t *testing.T) {
	for _, bind := range []string{"127.0.0.1", "::1", "[::1]"} {
		t.Run(bind, func(t *testing.T) {
			baseConfigEnv(t)
			t.Setenv("BIND_ADDR", bind)
			cfg, err := loadConfig()
			if err != nil {
				t.Fatal(err)
			}
			if cfg.BindAddr != bind {
				t.Fatalf("BindAddr = %q, want %q", cfg.BindAddr, bind)
			}
		})
	}
}

func TestHealthcheckTargetSelectsLoopbackOrBind(t *testing.T) {
	cases := []struct {
		bind, port, want string
	}{
		{"", "8080", "http://127.0.0.1:8080/readyz"},
		{"127.0.0.1", "8080", "http://127.0.0.1:8080/readyz"},
		{"localhost", "9090", "http://127.0.0.1:9090/readyz"},
		{"10.0.0.5", "8080", "http://10.0.0.5:8080/readyz"},
		{"::1", "8080", "http://[::1]:8080/readyz"},
		{"[::1]", "8080", "http://[::1]:8080/readyz"},
	}
	for _, tc := range cases {
		if got := healthcheckTarget(tc.bind, tc.port); got != tc.want {
			t.Errorf("healthcheckTarget(%q, %q) = %q, want %q", tc.bind, tc.port, got, tc.want)
		}
	}
}

func TestBootFieldsEchoBindAddr(t *testing.T) {
	cfg := bootConfig(t)
	cfg.BindAddr = "127.0.0.1"

	fields := bootFields(cfg, true)
	joined := ""
	for i := 0; i < len(fields); i += 2 {
		key, _ := fields[i].(string)
		val, _ := fields[i+1].(string)
		joined += key + "=" + val + " "
	}
	if !strings.Contains(joined, "bind_addr=127.0.0.1") {
		t.Errorf("boot fields %q missing bind_addr=127.0.0.1", joined)
	}
}
