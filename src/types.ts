export type Voice = "Joanna" | "Joey";
export type Deck = "aws-technical" | "conference-conversation" | "west-coast-slang";
export type Kind = "word" | "phrase";
export type CardStatus = "learning" | "known";

export interface Card {
  id: string;
  deck: Deck;
  kind: Kind;
  term: string;
  ja: string;
  example: string;
  exampleJa: string;
  voice: Voice;
  /** Relative paths to pre-generated MP3s. Absent/missing until audio is generated. */
  audioTerm: string;
  audioExample: string;
}

export interface DeckMeta {
  id: Deck;
  title: string;
  blurb: string;
}
