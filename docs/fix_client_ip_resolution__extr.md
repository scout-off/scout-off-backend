# Technical Specification: Fix client-IP resolution: extractClientIp is off by one for standard reverse proxies and the rate limiter ignores it

## Executive Summary
This document provides comprehensive technical details, operational context, and usage specifications for this component within scout-off-backend.

## Architecture & Invariants
- Standard state machine transitions
- Deterministic error boundaries
- Operational failure handling

## Guidelines & Runbook
1. Ensure local prerequisites are satisfied
2. Execute verification suites prior to deployment
3. Review automated audit logs for anomalies
