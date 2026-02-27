export interface GmailMessage {
  id: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  createdAt: string;
}

export interface GmailDraftInput {
  to: string;
  subject: string;
  body: string;
}
