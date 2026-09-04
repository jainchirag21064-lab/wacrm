---
name: wacrm-flow-authoring
description: "Create, review, validate, or repair WACRM WhatsApp flow JSON. Use when an AI agent needs to design a flow, generate an importable .json file, explain flow nodes, connect node branches, capture customer answers into vars, configure templates, or troubleshoot activation validation."
argument-hint: "Describe the customer journey, inputs, branches, messages, tags, and handoff behavior."
user-invocable: true
disable-model-invocation: false
---

# WACRM Flow Authoring

Use this skill when producing a WACRM flow definition for import into the Flow Builder or when reviewing an existing flow JSON file.

## Goal

Create a complete, importable JSON document with:

- A clear customer journey.
- An entry trigger and exactly one reachable entry node.
- Stable unique `node_key` values.
- Every outgoing branch connected to another node.
- Customer answers stored in `flow_runs.vars` when later messages need them.
- A terminal `handoff` or `end` path for every meaningful journey.

The import format is versioned as `format: "wacrm-flow"`, `version: 1`.

## Procedure

1. Translate the requested journey into states: entry, message, choice, input, branch, tag, handoff, and end.
2. Choose stable snake_case node keys before writing configs.
3. Build the node graph. Every `next_node_key`, button target, list-row target, and condition target must exactly match a node key.
4. Add `collect_input.var_key` or `send_list.capture_var_key` wherever a later node needs the answer.
5. Use `{{vars.key}}` for captured flow values and `{{contact.name}}`, `{{contact.phone}}`, `{{contact.email}}`, or `{{contact.company}}` for contact fields.
6. Validate WhatsApp limits and graph reachability using the checklist below.
7. Return only valid JSON when the user asks for an import file. Do not include Markdown fences around the JSON unless they ask for an explanation too.
8. Explain account-specific values that must be replaced before activation, especially `set_tag.tag_id` and approved template names/languages.

## Important Runtime Semantics

- `start`, `send_message`, `send_media`, `condition`, and `set_tag` auto-advance.
- `send_buttons`, `send_list`, and `collect_input` wait for the next customer reply.
- A `send_list` reply advances through the selected row's `next_node_key`. If `capture_var_key` is set, the selected row title is stored in that variable.
- A text-mode `collect_input` stores the trimmed inbound text under `var_key`.
- An options-mode `collect_input` sends buttons for up to 3 options, otherwise a WhatsApp list. The selected option stores `value` when present, otherwise its title, under `var_key`.
- `condition` reads a variable, tag, or contact field and routes to `true_next` or `false_next`.
- `set_tag` adds or removes an existing account tag, then continues.
- `handoff` ends the flow as handed off and can assign an agent; `end` completes the flow.
- A failed send or missing node ends the run as failed.

## Node Catalog

Use the schemas in [node-catalog.md](./references/node-catalog.md). The supported node types are:

- `start`: one `next_node_key`.
- `send_message`: plain text or approved WhatsApp template, then one `next_node_key`.
- `send_buttons`: body plus 1-3 reply buttons, each with its own target.
- `send_list`: body plus up to 10 rows across sections, each with its own target; optionally captures the selected title.
- `send_media`: image, video, or document URL, then one target.
- `collect_input`: free text or predefined options, stores one value under `var_key`, then one target.
- `condition`: branches on a variable, tag, or contact field.
- `set_tag`: add/remove an account tag, then one target.
- `handoff`: stop and hand the conversation to an agent.
- `end`: stop successfully.

## JSON Contract

Top-level shape:

```json
{
  "format": "wacrm-flow",
  "version": 1,
  "flow": {
    "name": "Human-readable name",
    "description": "Internal description",
    "trigger_type": "keyword",
    "trigger_config": {
      "keywords": ["hi", "hello"],
      "match_type": "contains",
      "case_sensitive": false
    },
    "entry_node_id": "start",
    "fallback_policy": {
      "on_unknown_reply": "reprompt",
      "max_reprompts": 2,
      "on_timeout_hours": 24,
      "on_exhaust": "handoff"
    }
  },
  "nodes": []
}
```

Allowed trigger types:

- `keyword`: `trigger_config.keywords` is a non-empty array. `match_type` is `exact` or `contains`; case-insensitive matching is the default.
- `first_inbound_message`: starts for the contact's first inbound message; config can be `{}`.
- `manual`: never auto-starts from inbound messages.

## Variables and Privacy

Use short, stable keys such as `destination`, `departure_city`, `travel_dates`, `travellers`, and `budget`.

Do not place passwords, payment card numbers, access tokens, or other secrets in prompts, node configs, or flow variables. Free-text answers are deliberately not copied into reply event payloads, but downstream handoff notes and messages can expose values through interpolation, so capture only what the business needs.

## Account-Specific Values

A developer-authored file cannot know the destination account's IDs. Before activation:

- Replace every `set_tag.tag_id` with a tag UUID that exists in the target account.
- Confirm every template `template_name` and `template_language` is approved and synced in the target account.
- Confirm media URLs are reachable by Meta.
- Do not use database flow IDs, node row IDs, run IDs, or contact IDs in the export.

## Final Validation Checklist

- Top-level format and version are exact.
- Flow name is non-empty.
- `entry_node_id` exists in `nodes`.
- Every `node_key` is unique and non-empty.
- There is a `start` node on the reachable path.
- Every referenced target exists.
- Every non-terminal path eventually reaches `handoff` or `end`.
- No unreachable nodes remain.
- `send_buttons` has 1-3 buttons; titles are at most 20 characters.
- `send_list` has 1-10 total rows; row titles are at most 24 characters; button label is at most 20 characters.
- `send_media` uses `image`, `video`, or `document` and has a public URL.
- Options-mode `collect_input` has at least one option and no more than 10 options.
- `condition` has valid subject, operator, and both targets.
- `set_tag` has `add` or `remove`, a real tag ID, and a target.
- Templates have a name and language; body/header/button parameter counts match the approved template.

For a field-by-field schema and examples, read [node-catalog.md](./references/node-catalog.md).
