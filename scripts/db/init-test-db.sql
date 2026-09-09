-- Runs once on first container init (docker-entrypoint-initdb.d). Creates a
-- second database, `apo_test`, alongside the default `apo` one, so the
-- integration test suite (`pnpm test:integration`) never touches dev data.
CREATE DATABASE apo_test;
