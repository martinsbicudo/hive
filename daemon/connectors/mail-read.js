ObjC.import("Foundation");

function readInput() {
  const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  const raw = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
  const input = JSON.parse(raw);
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("the input must be a JSON object");
  return input;
}

function textOf(value) {
  return value === null || value === undefined ? "" : String(value);
}

const BODY_LIMIT = 20480;

function run() {
  const input = readInput();
  const id = Number(input.id);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("id must be a Mail message id");
  const Mail = Application("Mail");
  const found = Mail.inbox.messages.whose({ id: id })();
  if (found.length === 0) return JSON.stringify({ found: false });
  const message = found[0];
  const date = message.dateReceived();
  return JSON.stringify({
    found: true,
    id: id,
    from: textOf(message.sender()),
    to: message.toRecipients.address().map(textOf),
    subject: textOf(message.subject()),
    date: date ? date.toISOString() : "",
    body: textOf(message.content()).slice(0, BODY_LIMIT),
  });
}
