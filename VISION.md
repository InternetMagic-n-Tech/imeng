# IMENG: Internet Magic Engine

**Small local models, made reliable by the system around them.**

Your models. Your machine. Your rules.

## 1. Vision

Local models are already capable enough to be useful. What they lack is the system around them: something that holds state, applies rules, manages context and recovers from mistakes, so the model only has to do the part it is good at.

IMENG is that system. It is an engine that makes small, low-parameter models on ordinary hardware complete real tasks, and hides the infrastructure, quantization, context and agent plumbing from the person using it.

The complexity lives in the engine, not in the user's workflow.

## 2. The Core Bet

**Move work out of the model and into code.**

Models are unreliable at remembering state, following long rule sets and tracking multi-step plans. Code is not. IMENG's engine owns state, rules, permissions, memory and orchestration. The model narrates, reasons and writes. Where a design needs a big model to work, the work moves into deterministic code or a smaller, narrower model call instead.

This is the differentiator. It is not "local AI with a nicer UI". It is "a small model that behaves like a much larger one because the engine carries the load."

**Proof:** the existing proxy (Open WebUI ↔ Ollama) already does this for text games. The server tracks HP, inventory, rules and turn order, injects state into every prompt, and a small judge model classifies moves. A low-parameter model gives a coherent, memorable game because the model never has to remember anything. IMENG generalizes this engine beyond games.

## 3. Principles

1. **Local-first.** Inference, data and project context stay on the user's hardware by default. External services are optional and explicit. Works offline wherever practical.
2. **Engine stays generic.** Domain rules, tone and wording live in user-editable packages (a game folder, a coding profile), never in the core.
3. **State lives outside the model.** If it must be remembered or enforced, the engine stores and enforces it.
4. **Sensible defaults, full override.** A first run needs no configuration. Everything is configurable afterward.
5. **Small models first.** Design for 7B to 30B models on consumer hardware. Larger models are a bonus, not a requirement.
6. **Respect the user.** Visible model choice, inspectable tool calls, explicit permissions, configurable autonomy, recoverable operations.
7. **Modular, not microservices.** Clear boundaries inside one cohesive application.

## 4. Non-Goals

- Training foundation models.
- Another generic chatbot.
- Matching every feature of cloud AI platforms. Expect "usable on the hardware you have", not "identical to a frontier model".
- Cloud accounts, mandatory telemetry or vendor lock-in.
- Chasing benchmark scores over completed tasks.
- Rebuilding what Ollama, llama.cpp or LM Studio already do well. IMENG sits on top of them.

## 5. Architecture

Conceptual boundaries, not separate services:

| Component | Responsibility |
|---|---|
| Core | Lifecycle, configuration, coordination |
| Inference Layer | Backend abstraction (Ollama first, others later) |
| State and Rules Engine | Session state, rule enforcement, turn control (exists today in the proxy) |
| Context Engine | Context construction, retrieval, compression |
| Memory | Session and persistent memory |
| Agent Runtime | Planning, tool loop, narrator/judge split, recovery |
| Tool System | Filesystem, terminal, Git, web, integrations |
| Project Intelligence | Repository indexing and code understanding |
| Experience Layer | CLI, chat UI bridges, guided setup |

## 6. Roadmap

Ordered so the novel work comes first and commodity work is borrowed.

**Phase 1: Generalize the engine.** Extract the proxy's state/rules/tool-loop engine from game-specific assumptions. Define a "profile" package format (the generalization of a game folder). Keep Ollama as the only backend.
*Done when:* a non-game profile (for example a coding helper) runs on the engine with no engine code changes.

**Phase 2: Coding intelligence.** Repository maps, indexing, project-aware context, multi-file edits with diff review, terminal and test feedback loops.
*Done when:* on a 16 GB machine with a 7B to 14B model, IMENG fixes a failing test in a small real repository without manual configuration, with the user approving each edit.

**Phase 3: Reliability on small models.** Task decomposition, failure recovery, context compression, persistent memory, permissions and execution monitoring.
*Done when:* a defined suite of multi-step tasks completes at a target success rate on a named small model. The suite is published and repeatable.

**Phase 4: Guided setup.** First-run wizard, hardware detection, model recommendation and install, capability check. Wrap Ollama and others rather than reimplementing them.
*Done when:* a fresh install reaches a working assistant in under 15 minutes with no config file edits.

**Phase 5: Extensibility.** Plugins, custom tools, additional backends, agent templates, a developer API.
*Done when:* a third party can add a tool or backend without touching the core.

## 7. Design Checklist

Before adding a feature, ask:

- Does it make small local models more reliable or capable?
- Does it move work out of the model and into code?
- Does it reduce complexity for the user?
- Does it preserve user control and work across hardware?
- Does it fit the existing system, or add a new moving part for little gain?

If it adds complexity without clear capability, don't build it.

## 8. Long-Term Vision

As models improve and hardware gets cheaper, the bottleneck shifts from model availability to the quality of the systems around the models. IMENG aims to be that system: local intelligence that is approachable as a desktop app and flexible as a developer platform, with the user in control.

*IMENG: Internet Magic Engine.* (Name note: the name is a joke on "Internet" for something that works offline. Keep it as an in-joke or rename before launch.)

## 9. Project Posture

IMENG is released under the MIT license and provided as is. It is built to be forked. Support, issue triage and pull-request review are best effort and not promised.
