export interface EviteHealth {
  ok: boolean;
  authMode: 'none';
  note: string;
}

export class EviteClient {
  health(): EviteHealth {
    return { ok: true, authMode: 'none', note: 'scaffold — auth + tools land in later plans' };
  }
}
