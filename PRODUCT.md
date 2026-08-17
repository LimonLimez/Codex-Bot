# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Inferred from the active brief: Windows users who want persistent AI employees that can chat, research the public web, use isolated computers, collaborate in groups, and run scheduled routines.

## Product Purpose

Open Bot turns a user-selected AI provider into a local-first desktop workforce. Success means employees complete useful work with transparent provider routing, verifiable evidence, durable preferences, and reliable background execution.

## Positioning

Open Bot combines provider choice with one private browser seat per employee, an optional separately authenticated vendor computer, and a locally supervised always-on worker.

## Operating Context

Users work in direct and group chats, choose models and response behavior per workspace or employee, inspect browser activity, approve consequential computer actions, and schedule recurring work while their Windows account remains signed in.

## Capabilities and Constraints

- Existing chat, provider, computer, group, and routine behavior must remain compatible with the patched Grok Bot 0.18 runtime.
- Research mode must use browser evidence and disclose real sources; it must not invent citations.
- GPT Image 2 uses the OpenAI Images API and therefore requires a direct OpenAI API key. Codex OAuth alone is not represented as Images API authorization.
- Private computer traffic stays on the existing authenticated loopback boundary. Vendor computer use remains separately authenticated and explicitly disclosed.
- Always On is a current-user Windows worker, not a machine-wide service, and cannot run while the Windows account is signed out.

## Brand Commitments

The product name is Open Bot. Preserve the incumbent dark desktop shell, concise plain-language copy, employee metaphor, and user-visible provider/computer boundaries.

## Evidence on Hand

The repository contains behavioral tests, a pinned vendor-runtime patch pipeline, Windows installer verification, and runtime audit tooling. No customer testimonials or external performance claims are available and none may be fabricated.

## Product Principles

1. Do useful work before narrating a plan.
2. Make provider, permission, evidence, and billing boundaries visible.
3. Prefer verified evidence over confident guesses.
4. Fail closed around credentials, remote control, and unsupported capabilities.
5. Keep background work durable, deduplicated, and inspectable.

## Accessibility & Inclusion

New controls must preserve keyboard operation, visible focus, accurate roles and labels, reduced-motion compatibility, and readable error recovery in the existing desktop shell.
