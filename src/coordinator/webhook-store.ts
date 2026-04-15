import { randomUUID } from 'node:crypto';

export interface Webhook {
  id: string;
  name: string;
  agentName: string;
  promptTemplate: string;
  secret?: string;
  orgId: string;
  createdAt: number;
  lastTriggeredAt?: number;
  triggerCount: number;
}

export interface WebhookStore {
  create(params: {
    name: string;
    agentName: string;
    promptTemplate: string;
    secret?: string;
    orgId?: string;
  }): Webhook;
  get(id: string): Webhook | null;
  getByName(name: string): Webhook | null;
  list(orgId?: string): Webhook[];
  delete(name: string): void;
  recordTrigger(name: string): void;
}

export class InMemoryWebhookStore implements WebhookStore {
  private byId = new Map<string, Webhook>();
  private byName = new Map<string, string>(); // name -> id

  create(params: {
    name: string;
    agentName: string;
    promptTemplate: string;
    secret?: string;
    orgId?: string;
  }): Webhook {
    if (this.byName.has(params.name)) {
      throw new Error(`Webhook name "${params.name}" already exists`);
    }
    const webhook: Webhook = {
      id: randomUUID(),
      name: params.name,
      agentName: params.agentName,
      promptTemplate: params.promptTemplate,
      secret: params.secret,
      orgId: params.orgId ?? '__default__',
      createdAt: Date.now(),
      triggerCount: 0,
    };
    this.byId.set(webhook.id, webhook);
    this.byName.set(webhook.name, webhook.id);
    return webhook;
  }

  get(id: string): Webhook | null {
    return this.byId.get(id) ?? null;
  }

  getByName(name: string): Webhook | null {
    const id = this.byName.get(name);
    if (!id) return null;
    return this.byId.get(id) ?? null;
  }

  list(orgId?: string): Webhook[] {
    const all = Array.from(this.byId.values());
    if (orgId !== undefined) {
      return all.filter(w => w.orgId === orgId);
    }
    return all;
  }

  delete(name: string): void {
    const id = this.byName.get(name);
    if (!id) return;
    this.byId.delete(id);
    this.byName.delete(name);
  }

  recordTrigger(name: string): void {
    const id = this.byName.get(name);
    if (!id) return;
    const webhook = this.byId.get(id);
    if (!webhook) return;
    webhook.triggerCount++;
    webhook.lastTriggeredAt = Date.now();
  }
}
