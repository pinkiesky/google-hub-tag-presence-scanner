export interface Tag {
  readonly id: string;
  readonly name: string;
  readonly pairDate: number;
  readonly eik: Buffer;
  readonly clockOffsetSeconds: number;
}
