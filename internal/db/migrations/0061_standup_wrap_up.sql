alter table sessions
  add column speaker_wrap_started_at timestamptz,
  add column speaker_wrap_until timestamptz,
  add constraint sessions_speaker_wrap_pair
    check ((speaker_wrap_started_at is null) = (speaker_wrap_until is null));
