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
  const to = input.to;
  if (!Array.isArray(to) || to.length < 1 || to.length > 10 || !to.every((address) => typeof address === "string")) throw new Error("to must list 1 to 10 addresses");
  if (typeof input.subject !== "string" || typeof input.body !== "string") throw new Error("subject and body must be text");
  const Mail = Application("Mail");
  const message = Mail.OutgoingMessage({ subject: input.subject, content: input.body, visible: false });
  Mail.outgoingMessages.push(message);
  for (const address of to) message.toRecipients.push(Mail.ToRecipient({ address: address }));
  if (message.send() === false) throw new Error("Mail didn't send the message");
  return JSON.stringify({ sent: true });
}
