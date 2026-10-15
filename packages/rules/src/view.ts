import { emojiGraphemes } from './emoji.js';
import { extractLinksDetailed, type LinkExtraction, type LinkInfo } from './links.js';
import { normalizeText, truncateForEvaluation, words } from './normalize.js';
import type { CommentFacts } from './types.js';

const MENTION = /@([\p{L}\p{N}_.]{1,100})/gu;

/** Derived views of one comment, each computed lazily and at most once. */
export class CommentView {
  readonly facts: CommentFacts;
  readonly raw: string;
  #normalized?: string;
  #words?: readonly string[];
  #extraction?: LinkExtraction;
  #emoji?: readonly string[];
  #mentions?: ReadonlySet<string>;

  constructor(facts: CommentFacts) {
    this.facts = facts;
    this.raw = truncateForEvaluation(facts.body);
  }

  get normalized(): string {
    return (this.#normalized ??= normalizeText(this.raw));
  }
  get words(): readonly string[] {
    return (this.#words ??= words(this.normalized));
  }
  get links(): readonly LinkInfo[] {
    return this.#linkExtraction().links;
  }
  /** True when the link cap stopped extraction: hosts after the cap were not examined. */
  get linksTruncated(): boolean {
    return this.#linkExtraction().truncated;
  }
  // Emoji read the RAW text: normalisation strips ZWJ and variation selectors.
  get emoji(): readonly string[] {
    return (this.#emoji ??= emojiGraphemes(this.raw));
  }
  get mentions(): ReadonlySet<string> {
    return (this.#mentions ??= new Set(
      [...this.normalized.matchAll(MENTION)].map((m) => m[1]!.replace(/\.+$/, '')),
    ));
  }

  #linkExtraction(): LinkExtraction {
    return (this.#extraction ??= extractLinksDetailed(this.raw));
  }
}
