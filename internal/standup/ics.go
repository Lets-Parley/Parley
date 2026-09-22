package standup

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/store"
)

// lookupPrefixLen is the leading characters of the plaintext token stored so a
// request can find its row. It matches the check constraint on
// ics_feed_tokens.lookup_prefix.
const lookupPrefixLen = 8

// RemindMinutesMin and RemindMinutesMax bound the single VALARM a feed carries.
const (
	RemindMinutesMin = 0
	RemindMinutesMax = 1440
)

// CalendarEvent is one async window on a personal feed. Link is the only
// text that goes in DESCRIPTION; Summary is the space name, never an entry.
type CalendarEvent struct {
	UID     string
	Start   time.Time
	End     time.Time
	Summary string
	Link    string
}

// RenderCalendar writes an RFC 5545 calendar: CRLF endings, 75-octet folding,
// TEXT escaping, and one DISPLAY alarm remindMinutes before each window.
// now is the DTSTAMP, so a caller can freeze it.
func RenderCalendar(now time.Time, remindMinutes int, events []CalendarEvent) string {
	var b strings.Builder
	writeLine := func(line string) {
		b.WriteString(foldLine(line))
		b.WriteString("\r\n")
	}
	writeLine("BEGIN:VCALENDAR")
	writeLine("VERSION:2.0")
	writeLine("PRODID:-//Parley//Async standup//EN")
	writeLine("CALSCALE:GREGORIAN")
	writeLine("METHOD:PUBLISH")
	for _, ev := range events {
		writeLine("BEGIN:VEVENT")
		writeLine("UID:" + ev.UID)
		writeLine("DTSTAMP:" + icsTime(now))
		writeLine("DTSTART:" + icsTime(ev.Start))
		writeLine("DTEND:" + icsTime(ev.End))
		writeLine("SUMMARY:" + escapeText(ev.Summary))
		writeLine("DESCRIPTION:" + escapeText(ev.Link))
		writeLine("BEGIN:VALARM")
		writeLine("ACTION:DISPLAY")
		writeLine("DESCRIPTION:Standup")
		writeLine("TRIGGER:" + alarmTrigger(remindMinutes))
		writeLine("END:VALARM")
		writeLine("END:VEVENT")
	}
	writeLine("END:VCALENDAR")
	return b.String()
}

func icsTime(t time.Time) string {
	return t.UTC().Format("20060102T150405Z")
}

func alarmTrigger(minutes int) string {
	if minutes <= 0 {
		return "PT0S"
	}
	return "-PT" + itoa(minutes) + "M"
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [12]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}

func escapeText(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch r {
		case '\\', ';', ',':
			b.WriteByte('\\')
			b.WriteRune(r)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			// A bare CR is not a TEXT newline; drop it so a name cannot
			// inject a second property line.
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

// foldLine splits a content line at 75 octets, continuing with CRLF + space.
// It steps back rather than cutting a UTF-8 sequence in half.
func foldLine(line string) string {
	b := []byte(line)
	if len(b) <= 75 {
		return line
	}
	var out strings.Builder
	first := 75
	for first > 0 && !utf8.RuneStart(b[first]) {
		first--
	}
	out.Write(b[:first])
	rest := b[first:]
	for len(rest) > 0 {
		out.WriteString("\r\n ")
		n := 74
		if n > len(rest) {
			n = len(rest)
		} else {
			for n > 0 && !utf8.RuneStart(rest[n]) {
				n--
			}
		}
		out.Write(rest[:n])
		rest = rest[n:]
	}
	return out.String()
}

// Feeds is the personal calendar: one revocable token per user, and the
// windows that token is allowed to see right now.
type Feeds struct {
	Pool *pgxpool.Pool
}

// Mint replaces the user's feed token and returns the plaintext, which is the
// only time it exists outside the hash. remindMinutes must already be in range.
func (f *Feeds) Mint(ctx context.Context, userID string, remindMinutes int) (string, error) {
	for range 5 {
		plain, hash := store.NewToken()
		if len(plain) < lookupPrefixLen {
			return "", errors.New("minting ics token: token was shorter than its lookup prefix")
		}
		_, err := f.Pool.Exec(ctx, `
			insert into ics_feed_tokens (user_id, lookup_prefix, token_hash, remind_minutes)
			values ($1, $2, $3, $4)
			on conflict (user_id) do update set
				lookup_prefix = excluded.lookup_prefix,
				token_hash = excluded.token_hash,
				remind_minutes = excluded.remind_minutes,
				created_at = now(),
				revoked_at = null`,
			userID, plain[:lookupPrefixLen], hash, remindMinutes)
		if err == nil {
			return plain, nil
		}
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			continue
		}
		return "", fmt.Errorf("saving ics token: %w", err)
	}
	return "", errors.New("saving ics token: lookup prefix collided")
}

// Revoke stamps the user's feed so the URL that was handed out stops resolving.
func (f *Feeds) Revoke(ctx context.Context, userID string) error {
	_, err := f.Pool.Exec(ctx,
		"update ics_feed_tokens set revoked_at = now() where user_id = $1 and revoked_at is null",
		userID)
	if err != nil {
		return fmt.Errorf("revoking ics token: %w", err)
	}
	return nil
}

// Active reports whether the user has a feed that still resolves, and the
// offset it will alarm at. The token itself is not recoverable.
func (f *Feeds) Active(ctx context.Context, userID string) (bool, int, error) {
	var minutes int
	err := f.Pool.QueryRow(ctx,
		"select remind_minutes from ics_feed_tokens where user_id = $1 and revoked_at is null",
		userID).Scan(&minutes)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, 0, nil
	}
	if err != nil {
		return false, 0, fmt.Errorf("reading ics token: %w", err)
	}
	return true, minutes, nil
}

// Lookup resolves a presented token to its user. A missing, malformed or
// revoked token is ok false and a nil error: the caller answers 404 either way.
func (f *Feeds) Lookup(ctx context.Context, plain string) (userID string, remindMinutes int, ok bool, err error) {
	hash, hashErr := store.HashToken(plain)
	if hashErr != nil || len(plain) < lookupPrefixLen {
		return "", 0, false, nil
	}
	var stored []byte
	err = f.Pool.QueryRow(ctx, `
		select user_id::text, remind_minutes, token_hash
		from ics_feed_tokens
		where lookup_prefix = $1 and revoked_at is null`,
		plain[:lookupPrefixLen]).Scan(&userID, &remindMinutes, &stored)
	if errors.Is(err, pgx.ErrNoRows) {
		var zero [32]byte
		subtle.ConstantTimeCompare(hash, zero[:])
		return "", 0, false, nil
	}
	if err != nil {
		return "", 0, false, fmt.Errorf("reading ics token: %w", err)
	}
	if subtle.ConstantTimeCompare(hash, stored) != 1 {
		return "", 0, false, nil
	}
	return userID, remindMinutes, true, nil
}

// Events lists the async windows this user can see at now: standups whose
// window is still open, and enabled schedules' slots inside the next 14 days.
// Membership is read here, not remembered from when the token was minted.
// Description text is never loaded.
func (f *Feeds) Events(ctx context.Context, userID, baseURL string, now time.Time) ([]CalendarEvent, error) {
	base := strings.TrimRight(baseURL, "/")
	type scheduled struct {
		id, name, org, slug string
		Schedule
	}
	rows, err := f.Pool.Query(ctx, `
		select sc.id::text, sp.name, o.slug, sp.slug,
		       sc.weekdays, to_char(sc.open_time, 'HH24:MI'), sc.timezone, sc.window_minutes
		from standup_schedules sc
		join spaces sp on sp.id = sc.space_id
		join orgs o on o.id = sp.org_id
		join members m on m.space_id = sp.id and m.user_id = $1
		where sc.enabled`, userID)
	if err != nil {
		return nil, fmt.Errorf("listing standup schedules for a feed: %w", err)
	}
	var schedules []scheduled
	for rows.Next() {
		var s scheduled
		var days []int16
		if err := rows.Scan(&s.id, &s.name, &s.org, &s.slug, &days, &s.OpenTime, &s.Timezone, &s.WindowMinutes); err != nil {
			rows.Close()
			return nil, fmt.Errorf("listing standup schedules for a feed: %w", err)
		}
		for _, d := range days {
			s.Weekdays = append(s.Weekdays, int(d))
		}
		schedules = append(schedules, s)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("listing standup schedules for a feed: %w", err)
	}

	slotSession := map[string]string{}
	slotRows, err := f.Pool.Query(ctx, `
		select sl.schedule_id::text, to_char(sl.slot_date, 'YYYYMMDD'), sl.session_id::text
		from standup_schedule_slots sl
		join standup_schedules sc on sc.id = sl.schedule_id
		join members m on m.space_id = sc.space_id and m.user_id = $1
		where sl.session_id is not null
		  and sl.slot_date >= ($2::timestamptz - interval '2 days')::date
		  and sl.slot_date <= ($2::timestamptz + interval '15 days')::date`,
		userID, now)
	if err != nil {
		return nil, fmt.Errorf("listing standup slots for a feed: %w", err)
	}
	for slotRows.Next() {
		var scheduleID, date, sessionID string
		if err := slotRows.Scan(&scheduleID, &date, &sessionID); err != nil {
			slotRows.Close()
			return nil, fmt.Errorf("listing standup slots for a feed: %w", err)
		}
		slotSession[scheduleID+"|"+date] = sessionID
	}
	slotRows.Close()
	if err := slotRows.Err(); err != nil {
		return nil, fmt.Errorf("listing standup slots for a feed: %w", err)
	}

	var events []CalendarEvent
	covered := map[string]bool{}
	for _, s := range schedules {
		windows, err := s.upcoming(now)
		if err != nil {
			return nil, fmt.Errorf("computing standup windows: %w", err)
		}
		for _, w := range windows {
			key := s.id + "|" + w.Date
			link := base + "/o/" + s.org + "/s/" + s.slug
			if sessionID := slotSession[key]; sessionID != "" {
				link = base + "/session/" + sessionID
				covered[sessionID] = true
			}
			events = append(events, CalendarEvent{
				UID:     "standup-" + s.id + "-" + w.Date + "@parley",
				Start:   w.Open,
				End:     w.Close,
				Summary: s.name + " standup",
				Link:    link,
			})
		}
	}

	sessRows, err := f.Pool.Query(ctx, `
		select s.id::text, s.created_at, s.config, sp.name
		from sessions s
		join spaces sp on sp.id = s.space_id
		join orgs o on o.id = sp.org_id
		join members m on m.space_id = sp.id and m.user_id = $1
		where s.kind = 'standup' and s.ended_at is null
		  and s.config->>'mode' = 'async'`, userID)
	if err != nil {
		return nil, fmt.Errorf("listing open standups for a feed: %w", err)
	}
	defer sessRows.Close()
	for sessRows.Next() {
		var id, name string
		var created time.Time
		var raw []byte
		if err := sessRows.Scan(&id, &created, &raw, &name); err != nil {
			return nil, fmt.Errorf("listing open standups for a feed: %w", err)
		}
		if covered[id] {
			continue
		}
		var cfg Config
		if err := json.Unmarshal(raw, &cfg); err != nil || !cfg.async() {
			continue
		}
		if cfg.ClosesAt != nil && !cfg.ClosesAt.After(now) {
			continue
		}
		end := created.Add(24 * time.Hour)
		if cfg.ClosesAt != nil {
			end = *cfg.ClosesAt
		}
		if !end.After(created) {
			continue
		}
		events = append(events, CalendarEvent{
			UID:     "standup-" + id + "@parley",
			Start:   created,
			End:     end,
			Summary: name + " standup",
			Link:    base + "/session/" + id,
		})
	}
	if err := sessRows.Err(); err != nil {
		return nil, fmt.Errorf("listing open standups for a feed: %w", err)
	}
	sort.Slice(events, func(i, j int) bool {
		if !events[i].Start.Equal(events[j].Start) {
			return events[i].Start.Before(events[j].Start)
		}
		return events[i].UID < events[j].UID
	})
	return events, nil
}
