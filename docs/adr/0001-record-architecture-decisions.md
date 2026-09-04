# 1. Record architecture decisions

Date: 2026-07-01

## Status

Accepted

## Context

This is a portfolio project, but its value is in demonstrating *judgment*, not
just working code. The reasoning behind non-obvious choices (why an outbox, why
not Nest, how money is represented) is easy to lose and worth capturing.

## Decision

We keep short Architecture Decision Records under `docs/adr/`, one file per
decision, in the format popularized by Michael Nygard.

## Consequences

A reader (or interviewer) can follow *why* the system looks the way it does, not
just *what* it does. New decisions append rather than rewrite history.
