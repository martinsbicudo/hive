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

function run() {
  const input = readInput();
  const limit = Number(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("limit must be 1 to 20");
  const Mail = Application("Mail");
  const unread = Mail.inbox.messages.whose({ readStatus: false });
  const ids = unread.id();
  const dates = unread.dateReceived();
  const senders = unread.sender();
  const subjects = unread.subject();
  const order = ids.map((_, index) => index).sort((a, b) => Number(dates[b]) - Number(dates[a])).slice(0, limit);
  const messages = order.map((index) => ({
    id: ids[index],
    from: textOf(senders[index]),
    subject: textOf(subjects[index]),
    date: dates[index] ? dates[index].toISOString() : "",
  }));
  return JSON.stringify({ messages });
}
