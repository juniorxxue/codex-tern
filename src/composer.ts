import { Draft } from './draft';

export interface SubmissionDraft {
  text: string;
  images: string[];
  draft: Draft;
  textRevision: number;
  imageRevision: number;
}

/** Text and attachments travel together when selecting a session or recovering a send. */
export class Composer {
  draft = new Draft();
  private paths: readonly string[] = [];
  private imageRevision = 0;

  get images() { return this.paths; }
  set images(paths: readonly string[]) { this.paths = [...paths]; this.imageRevision++; }

  take(): SubmissionDraft {
    const text = this.draft.submittedText, images = [...this.images];
    this.draft.set(''); this.images = [];
    return { text, images, draft: this.draft, textRevision: this.draft.revision, imageRevision: this.imageRevision };
  }

  restore(input: SubmissionDraft): boolean {
    if (this.draft !== input.draft || this.draft.revision !== input.textRevision
      || this.imageRevision !== input.imageRevision) return false;
    this.draft.set(input.text); this.images = input.images;
    return true;
  }
}
