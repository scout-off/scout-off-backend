import { Player, Milestone, Scout, ContractEvent, ContactUnlock } from '../types';

interface StoreData {
  players: Map<string, Player>;
  milestones: Map<string, Milestone>;
  scouts: Map<string, Scout>;
  events: ContractEvent[];
  contactUnlocks: Map<string, ContactUnlock>;
}

const store: StoreData = {
  players: new Map(),
  milestones: new Map(),
  scouts: new Map(),
  events: [],
  contactUnlocks: new Map(),
};

export function resetStore(): void {
  store.players.clear();
  store.milestones.clear();
  store.scouts.clear();
  store.events = [];
  store.contactUnlocks.clear();
}

export function getPlayers(): Player[] {
  return Array.from(store.players.values());
}

export function getPlayer(playerId: string): Player | undefined {
  return store.players.get(playerId);
}

export function addPlayer(player: Player): void {
  store.players.set(player.playerId, {
    ...player,
    updatedAt: Math.floor(Date.now() / 1000),
  });
}

export function updatePlayer(playerId: string, updates: Partial<Player>): void {
  const player = store.players.get(playerId);
  if (player) {
    store.players.set(playerId, {
      ...player,
      ...updates,
      updatedAt: Math.floor(Date.now() / 1000),
    });
  }
}

export function deletePlayer(playerId: string): void {
  store.players.delete(playerId);
}

export function getMilestones(): Milestone[] {
  return Array.from(store.milestones.values());
}

export function getMilestone(milestoneId: string): Milestone | undefined {
  return store.milestones.get(milestoneId);
}

export function getPlayerMilestones(playerId: string): Milestone[] {
  return Array.from(store.milestones.values()).filter(m => m.playerId === playerId);
}

export function addMilestone(milestone: Milestone): void {
  store.milestones.set(milestone.milestoneId, milestone);
}

export function updateMilestone(milestoneId: string, updates: Partial<Milestone>): void {
  const milestone = store.milestones.get(milestoneId);
  if (milestone) {
    store.milestones.set(milestoneId, { ...milestone, ...updates });
  }
}

export function deleteMilestone(milestoneId: string): void {
  store.milestones.delete(milestoneId);
}

export function getScouts(): Scout[] {
  return Array.from(store.scouts.values());
}

export function getScout(wallet: string): Scout | undefined {
  return store.scouts.get(wallet);
}

export function addScout(scout: Scout): void {
  store.scouts.set(scout.wallet, scout);
}

export function updateScout(wallet: string, updates: Partial<Scout>): void {
  const scout = store.scouts.get(wallet);
  if (scout) {
    store.scouts.set(wallet, { ...scout, ...updates });
  }
}

export function deleteScout(wallet: string): void {
  store.scouts.delete(wallet);
}

export function getEvents(): ContractEvent[] {
  return [...store.events];
}

export function addEvent(event: ContractEvent): void {
  store.events.push(event);
}

export function getContactUnlocks(): ContactUnlock[] {
  return Array.from(store.contactUnlocks.values());
}

export function getContactUnlock(key: string): ContactUnlock | undefined {
  return store.contactUnlocks.get(key);
}

export function addContactUnlock(unlock: ContactUnlock): void {
  const key = `${unlock.scout}-${unlock.playerId}`;
  store.contactUnlocks.set(key, unlock);
}
