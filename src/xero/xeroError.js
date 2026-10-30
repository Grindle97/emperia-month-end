// Making sense of what xero-node throws, which is not an Error.
//
// On any non-2xx the generated SDK does:
//
//   reject(JSON.stringify(errorResponse.generateError()))
//
// — a JSON STRING. So `err.message` is undefined, `err.response` is undefined,
// and `err instanceof Error` is false. The status is at `response.statusCode`
// inside the parsed object, not at `err.response.status` where an axios error
// would put it.
//
// The visible cost: every failing Xero call logged `Tool "x" failed: undefined`
// and handed the model `{error: true, message: undefined}`. Asked for three
// invoice PDFs, the agent could only say "all three failed with an error (no further
// detail was returned by the tool)" — while the actual error said the
// connection lacked the attachments scope, which is a two-minute fix.
//
// A second, rarer shape exists too: `reject({ response, body })` where response
// is a raw axios response carrying `.status`. Both are handled.

const MAX_BODY_CHARS = 400;

function parseIfJson(value) {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function bodyText(body) {
  if (body === undefined || body === null) return '';
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}…` : text;
}

/**
 * Normalise anything Xero throws into something reportable.
 *
 * NOTE what is deliberately dropped: ApiError captures the REQUEST HEADERS,
 * which include the Authorization bearer token. Those must never reach a log
 * line or a tool result, so only the status and the response body are read.
 *
 * @returns {{status: number|null, message: string, body: string}} `message` is
 *   always a non-empty string — that is the whole point.
 */
function describeXeroError(err) {
  // The string shape the generated SDK actually uses.
  const parsed = parseIfJson(err);
  if (parsed) {
    const status = (parsed.response && parsed.response.statusCode) || null;
    const body = bodyText(parsed.body !== undefined ? parsed.body : (parsed.response || {}).body);
    return {
      status,
      body,
      message: `Xero returned ${status || 'an error'}${body ? `: ${body}` : '.'}`,
    };
  }

  if (err && typeof err === 'object') {
    const status = (err.response && (err.response.status || err.response.statusCode))
      || err.statusCode || null;
    const body = bodyText(err.body !== undefined ? err.body : (err.response || {}).data);
    if (err.message) {
      return { status, body, message: err.message };
    }
    return {
      status,
      body,
      message: `Xero returned ${status || 'an error with no message'}${body ? `: ${body}` : '.'}`,
    };
  }

  // A thrown string that is not JSON, or anything else at all. Never return an
  // empty message: "the tool failed and I cannot tell you why" is the outcome
  // this module exists to prevent.
  const text = String(err === undefined || err === null ? '' : err).trim();
  return { status: null, body: '', message: text || 'an unknown error with no message' };
}

module.exports = { describeXeroError };
