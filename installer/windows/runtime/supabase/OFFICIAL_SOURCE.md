# Vendored Supabase self-hosted runtime

This directory is copied from the official Supabase repository.

- Release: `self-hosted/v0.8.0`
- Commit: `241bb11c0627f2981746d37033f57dbfa81d29b0`
- Source: <https://github.com/supabase/supabase/tree/241bb11c0627f2981746d37033f57dbfa81d29b0/docker>
- PostgreSQL: 17 (`docker-compose.pg17.yml`)

`docker-compose.samrat.yml` is the Samrat-specific override. The remaining
runtime files retain the official release so image versions and Supabase
service configuration are reproducible.
