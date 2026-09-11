import type Anthropic from '@anthropic-ai/sdk';

/**
 * The model's action vocabulary.
 *
 * Every tool that touches a control takes a `control` *number* from the screen
 * listing rather than a selector or a description. That is the central choice
 * in this design: the model is good at looking at a screen and saying which
 * thing to press, and bad at inventing targeting that will still work in six
 * months. So it picks, and deterministic code in synthesize.ts derives the
 * durable target from the control it picked. A model cannot write a fragile
 * selector into an artifact because it is never asked to write one.
 *
 * `intent` is required on every action. It becomes the step's human-readable
 * intent in the artifact and the line an operator reads when the step
 * escalates, so it is worth the tokens.
 */

const control = {
  type: 'integer' as const,
  description: 'The number of the control from the CONTROLS listing on the current screen.',
};

const intent = {
  type: 'string' as const,
  description:
    'One sentence, in plain language, describing what this step accomplishes. It is recorded in the capability and shown to a human operator if the step ever needs one.',
};

export const DISCOVERY_TOOLS: Anthropic.Tool[] = [
  {
    name: 'click',
    description: 'Click a link, button or tab on the current screen.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { control, intent },
      required: ['control', 'intent'],
      additionalProperties: false,
    },
  },
  {
    name: 'type_text',
    description:
      'Type into a text field. Use the exact value you were given in INPUTS or CREDENTIALS; do not invent one.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        control,
        text: { type: 'string', description: 'The text to type.' },
        intent,
      },
      required: ['control', 'text', 'intent'],
      additionalProperties: false,
    },
  },
  {
    name: 'select_option',
    description: 'Choose an option in a dropdown by its visible label.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        control,
        option: { type: 'string', description: 'The visible label of the option to choose.' },
        intent,
      },
      required: ['control', 'option', 'intent'],
      additionalProperties: false,
    },
  },
  {
    name: 'press_key',
    description: 'Press a key, optionally while focused on a control. Useful for submitting a form with Enter.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key name, e.g. Enter or Tab.' },
        control: { ...control, description: `${control.description} Omit to press the key globally.` },
        intent,
      },
      required: ['key', 'intent'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_value',
    description:
      'Record a value from the screen as an output of this capability. Read the cell or field that holds the value, not the label beside it.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        control,
        key: {
          type: 'string',
          description: 'snake_case or camelCase name for this output, e.g. savingsBalance.',
        },
        value_type: { type: 'string', enum: ['string', 'number'], description: 'Type the caller receives.' },
        description: { type: 'string', description: 'What this value means, for the calling agent.' },
        intent,
      },
      required: ['control', 'key', 'value_type', 'description', 'intent'],
      additionalProperties: false,
    },
  },
  {
    name: 'finish',
    description:
      'Call this once the goal is achieved and every value the goal asked for has been read. Declare the outcomes this capability should recognise on future runs.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'One or two sentences describing what this capability does.' },
        outcomes: {
          type: 'array',
          description:
            'Results other than success that a future run could legitimately reach — a record that does not exist, a permission denial, a session that timed out, an error page. Base these on what you saw of how this application reports problems.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'SCREAMING_SNAKE_CASE, e.g. MEMBER_NOT_FOUND.' },
              description: { type: 'string' },
              when_text_contains: {
                type: 'string',
                description: 'Text that appears on screen when this outcome occurs. Leave empty if detecting it by HTTP status alone.',
              },
              when_http_status: {
                type: 'array',
                items: { type: 'integer' },
                description: 'HTTP statuses that indicate this outcome, e.g. [403].',
              },
              disposition: {
                type: 'string',
                enum: ['answer', 'needs_human'],
                description:
                  'answer means the caller asked a question and this is a legitimate reply. needs_human means a person has to look at it.',
              },
            },
            required: ['name', 'description', 'disposition'],
            additionalProperties: false,
          },
        },
      },
      required: ['summary', 'outcomes'],
      additionalProperties: false,
    },
  },
  {
    name: 'give_up',
    description:
      'Call this when you cannot make progress — the screen does not offer what the goal needs, or you would have to take an action you were told not to take.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { reason: { type: 'string' } },
      required: ['reason'],
      additionalProperties: false,
    },
  },
];

export type DiscoveryToolName =
  | 'click'
  | 'type_text'
  | 'select_option'
  | 'press_key'
  | 'read_value'
  | 'finish'
  | 'give_up';
