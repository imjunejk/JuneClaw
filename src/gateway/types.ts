export interface IncomingMessage {
  id: number;
  guid: string;
  chatId: number;
  text: string;
  sender: string;
  isFromMe: boolean;
  createdAt: string;
}

export interface Channel {
  pollNewMessages(): Promise<IncomingMessage[]>;
  sendMessage(text: string): Promise<void>;
}
