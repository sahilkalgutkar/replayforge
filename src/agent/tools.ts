// What the model can do during discovery.
//
// Every action on a control takes the control's *number* from the screen
// listing, never a selector. The model is good at looking at a screen and
// saying which thing to press; it's bad at inventing targeting that still works
// months later. So it picks, and synthesize.ts works out the durable target from
// what it picked.
//
// These are written as plain JSON schemas rather than one provider's tool
// format, so any model backend can use them.

export type DiscoveryToolName =
  | 'click'
  | 'type_text'
  | 'select_option'
  | 'press_key'
  | 'read_value'
  | 'finish'
  | 'give_up'
  | 'name_outcome';

type JsonSchema = Record<string, unknown>;

export interface ToolSpec {
  readonly name: DiscoveryToolName;
  readonly description: string;
  readonly parameters: {
    readonly properties: Readonly<Record<string, JsonSchema>>;
    readonly required: readonly string[];
  };
}

const control = { type: 'integer', description: 'Number of the control in the CONTROLS listing.' };
const intent = {
  type: 'string',
  description: 'One plain sentence on what this step does. It is saved with the flow and shown to a person if the step ever needs one.',
};

export const DISCOVERY_TOOLS: readonly ToolSpec[] = [
  {
    name: 'click',
    description: 'Click a link, button or tab.',
    parameters: { properties: { control, intent }, required: ['control', 'intent'] },
  },
  {
    name: 'type_text',
    description: 'Type into a text field. Use the exact value from INPUTS or CREDENTIALS; never make one up.',
    parameters: {
      properties: { control, text: { type: 'string', description: 'What to type.' }, intent },
      required: ['control', 'text', 'intent'],
    },
  },
  {
    name: 'select_option',
    description: 'Pick an option in a dropdown by its visible label.',
    parameters: {
      properties: { control, option: { type: 'string', description: 'Visible label of the option.' }, intent },
      required: ['control', 'option', 'intent'],
    },
  },
  {
    name: 'press_key',
    description: 'Press a key, such as Enter to submit a form.',
    parameters: {
      properties: { key: { type: 'string', description: 'Key name, e.g. Enter.' }, control, intent },
      required: ['key', 'intent'],
    },
  },
  {
    name: 'read_value',
    description: 'Record a value from the screen as an output. Read the cell holding the value, not the label next to it.',
    parameters: {
      properties: {
        control,
        key: { type: 'string', description: 'camelCase name for the output, e.g. savingsBalance.' },
        value_type: {
          type: 'string',
          enum: ['string', 'number'],
          description: 'number for amounts, balances and counts; string for everything else.',
        },
        description: { type: 'string', description: 'What the value means.' },
        intent,
      },
      required: ['control', 'key', 'value_type', 'description', 'intent'],
    },
  },
  {
    name: 'finish',
    description: 'Call once the goal is done and every value it asked for has been read.',
    parameters: {
      properties: {
        summary: { type: 'string', description: 'One or two sentences on what this flow does.' },
        outcomes: {
          type: 'array',
          description:
            'Results other than success a future run could reach, such as a record that does not exist, a permission denial, a session timeout or an error page.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'SCREAMING_SNAKE_CASE, e.g. MEMBER_NOT_FOUND.' },
              description: { type: 'string' },
              when_text_contains: {
                type: 'string',
                description: "Exact wording you have seen on screen for this. Leave it out if you haven't seen it.",
              },
              when_http_status: {
                type: 'array',
                items: { type: 'integer' },
                description: 'Standard statuses need no screen: 401 session expired, 403 access denied, 500/502/503 error page.',
              },
              disposition: {
                type: 'string',
                enum: ['answer', 'needs_human'],
                description:
                  'answer when the result itself answers the caller, such as no such record. needs_human when a person has to act, such as access denied, an expired session or an error page.',
              },
            },
            required: ['name', 'description', 'disposition'],
          },
        },
      },
      required: ['summary', 'outcomes'],
    },
  },
  {
    name: 'give_up',
    description: 'Call when you cannot make progress, or would have to do something you were told not to.',
    parameters: {
      properties: { reason: { type: 'string', description: 'Why.' } },
      required: ['reason'],
    },
  },
];

/** Used after discovery, when the system shows the model a failure screen it found. */
export const OUTCOME_TOOL: ToolSpec = {
  name: 'name_outcome',
  description: 'Say which outcome this screen is, and quote the words on it that identify it.',
  parameters: {
    properties: {
      name: { type: 'string', description: 'SCREAMING_SNAKE_CASE, e.g. MEMBER_NOT_FOUND.' },
      description: { type: 'string', description: 'What this outcome means for the caller.' },
      when_text_contains: {
        type: 'string',
        description: 'A short phrase copied exactly from the screen text that shows this outcome.',
      },
      disposition: {
        type: 'string',
        enum: ['answer', 'needs_human'],
        description: 'answer when the result itself answers the caller; needs_human when a person has to act.',
      },
    },
    required: ['name', 'description', 'when_text_contains', 'disposition'],
  },
};

/**
 * One JSON object naming a tool and its arguments. Used with backends that can
 * constrain a reply to a schema, which is more reliable than tool-call parsing
 * on smaller local models.
 */
export function decisionSchema(tools: readonly ToolSpec[]): JsonSchema {
  return {
    anyOf: tools.map((tool) => ({
      type: 'object',
      properties: { tool: { const: tool.name }, ...tool.parameters.properties },
      required: ['tool', ...tool.parameters.required],
      additionalProperties: false,
    })),
  };
}
