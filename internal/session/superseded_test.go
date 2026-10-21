package session

import (
	"errors"
	"testing"
)

func TestSupersededStateIsReadAgainAndThenGivenUp(t *testing.T) {
	reads := 0
	err := readUntilCurrent(func() error {
		reads++
		if reads == 1 {
			return ErrStateSuperseded
		}
		return nil
	})
	if err != nil || reads != 2 {
		t.Fatalf("one superseded read: %v after %d reads", err, reads)
	}

	reads = 0
	err = readUntilCurrent(func() error {
		reads++
		return ErrStateSuperseded
	})
	if !errors.Is(err, ErrStateSuperseded) || reads != supersededStateReads {
		t.Fatalf("always superseded: %v after %d reads", err, reads)
	}

	reads = 0
	failure := errors.New("database is gone")
	err = readUntilCurrent(func() error {
		reads++
		return failure
	})
	if !errors.Is(err, failure) || reads != 1 {
		t.Fatalf("another failure must not be retried: %v after %d reads", err, reads)
	}
}
