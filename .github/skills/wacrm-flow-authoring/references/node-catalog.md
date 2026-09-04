# WACRM Node Catalog

All nodes are objects in the top-level `nodes` array. `node_key` is the stable graph identifier. Node IDs are not UUIDs and must be unique within the file.

## Start

```json
{
  "node_key": "start",
  "node_type": "start",
  "config": { "next_node_key": "welcome" },
  "position_x": 0,
  "position_y": 0
}
```

Use exactly one logical entry path. The flow's `entry_node_id` must point to this node or another intentionally chosen first node.

## Send Message

Plain text:

```json
{
  "node_key": "welcome",
  "node_type": "send_message",
  "config": {
    "message_type": "text",
    "text": "Hello {{contact.name}}!",
    "next_node_key": "main_menu"
  }
}
```

Approved template:

```json
{
  "node_key": "appointment_reminder",
  "node_type": "send_message",
  "config": {
    "message_type": "template",
    "template_name": "appointment_reminder",
    "template_language": "en_US",
    "template_params": ["{{vars.date}}", "{{vars.time}}"],
    "template_header_text": "{{contact.name}}",
    "template_button_params": { "0": "confirm-123" },
    "next_node_key": "end"
  }
}
```

Template fields are optional and depend on the approved template. `template_params` supplies body variables in positional order. `template_header_text` supplies a variable text header. `template_button_params` is keyed by button index for variable URL or copy-code buttons.

## Send Buttons

```json
{
  "node_key": "main_menu",
  "node_type": "send_buttons",
  "config": {
    "text": "What do you need?",
    "header_text": "Support",
    "footer_text": "Choose one",
    "buttons": [
      { "reply_id": "sales", "title": "Sales", "next_node_key": "sales_input" },
      { "reply_id": "support", "title": "Support", "next_node_key": "support_input" }
    ]
  }
}
```

Use 1-3 buttons. Each `reply_id` must be unique in the node, and each title must fit WhatsApp's button limit.

## Send List

```json
{
  "node_key": "travel_menu",
  "node_type": "send_list",
  "config": {
    "text": "How can we help?",
    "button_label": "View options",
    "sections": [
      {
        "title": "Services",
        "rows": [
          {
            "reply_id": "plan_trip",
            "title": "Plan a trip",
            "description": "Tell us your travel needs",
            "next_node_key": "destination"
          }
        ]
      }
    ],
    "capture_var_key": "selected_service"
  }
}
```

Use 1-10 total rows across all sections. `capture_var_key` is optional. When present, the selected row title is stored in `flow_runs.vars[capture_var_key]` before advancing. If later text should say what the customer selected, use `{{vars.selected_service}}`.

## Send Media

```json
{
  "node_key": "brochure",
  "node_type": "send_media",
  "config": {
    "media_type": "document",
    "media_url": "https://example.com/brochure.pdf",
    "caption": "Here is our brochure.",
    "filename": "brochure.pdf",
    "next_node_key": "handoff"
  }
}
```

`media_type` must be `image`, `video`, or `document`. The URL must be publicly fetchable by Meta.

## Collect Input

Free text:

```json
{
  "node_key": "destination",
  "node_type": "collect_input",
  "config": {
    "prompt_text": "Which destination do you have in mind?",
    "var_key": "destination",
    "input_mode": "text",
    "next_node_key": "departure_city"
  }
}
```

Predefined options:

```json
{
  "node_key": "trip_type",
  "node_type": "collect_input",
  "config": {
    "prompt_text": "What kind of trip are you planning?",
    "var_key": "trip_type",
    "input_mode": "options",
    "options": [
      { "reply_id": "family", "title": "Family holiday", "value": "family" },
      { "reply_id": "business", "title": "Business trip", "value": "business" }
    ],
    "next_node_key": "destination"
  }
}
```

The selected option stores `value` when provided, otherwise `title`. Up to 3 options are sent as buttons; more are sent as a WhatsApp list. `validation` and `regex` are accepted for forward compatibility but are not currently enforced by the runtime.

## Condition

```json
{
  "node_key": "has_destination",
  "node_type": "condition",
  "config": {
    "subject": "var",
    "subject_key": "destination",
    "operator": "present",
    "true_next": "confirm_destination",
    "false_next": "destination"
  }
}
```

`subject` is `var`, `tag`, or `contact_field`. For `var`, `subject_key` is a variable name. For `tag`, it is a tag UUID. For `contact_field`, it is `name`, `email`, `phone`, or `company`. Operators are `equals`, `contains`, `present`, and `absent`. `value` is used by `equals` and `contains`.

## Set Tag

```json
{
  "node_key": "tag_lead",
  "node_type": "set_tag",
  "config": {
    "mode": "add",
    "tag_id": "REPLACE_WITH_TARGET_ACCOUNT_TAG_UUID",
    "next_node_key": "handoff"
  }
}
```

`mode` is `add` or `remove`. The tag must exist in the target account.

## Handoff

```json
{
  "node_key": "handoff",
  "node_type": "handoff",
  "config": {
    "note": "Customer needs help with {{vars.destination}}.",
    "assign_to": "OPTIONAL_AGENT_USER_ID"
  }
}
```

This terminates the flow as handed off and changes the conversation to pending. `note` and `assign_to` are optional. Treat `assign_to` as account-specific.

## End

```json
{
  "node_key": "end",
  "node_type": "end",
  "config": {}
}
```

## Graph Patterns

A linear path uses one target:

```text
start -> message -> collect_input -> message -> end
```

A choice fans out from button/list rows:

```text
start -> menu
             |-- row A -> path_a
             |-- row B -> path_b
             `-- row C -> handoff
```

A condition must define both branches:

```text
condition -- true  -> qualified
          `-- false -> collect_more
```

Avoid cycles unless the journey intentionally returns to a menu. If a node returns to `start`, make sure the flow can still terminate or hand off.
