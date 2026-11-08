/**
 * 頁面上那些固定 id 的節點。
 *
 * 全部 `byId`（取不到就拋）——這些 id 都在 src/shells/shared/panes.ts 裡，
 * 缺一個說明模板與前端不同步，早點炸比晚點炸好。**可選的**那幾個
 * （獨立版專屬的徽標、內建編輯器容器）各自就地 `maybeById` 探測，不進這裡。
 */
import { byId } from '../dom';

export const el = {
  tabbar: byId('tabbar'),
  messages: byId('messages'),
  emptyHint: byId('emptyHint'),
  initHint: byId('initHint'),
  newSessionBtn: byId<HTMLButtonElement>('newSessionBtn'),
  renamePlotBtn: byId<HTMLButtonElement>('renamePlotBtn'),
  workbench: byId<HTMLButtonElement>('workbench'),
  nextStep: byId('nextStep'),
  nextStepHint: byId('nextStepHint'),
  nextStepBtn: byId<HTMLButtonElement>('nextStepBtn'),
  gateDock: byId('gateDock'),
  cmdBtn: byId<HTMLButtonElement>('cmdBtn'),
  pendingCmd: byId('pendingCmd'),
  chips: byId('chips'),
  composerInput: byId('composerInput'),
  input: byId<HTMLTextAreaElement>('input'),
  atBtn: byId<HTMLButtonElement>('atBtn'),
  selBtn: byId<HTMLButtonElement>('selBtn'),
  modelSelect: byId<HTMLSelectElement>('modelSelect'),
  thinkSelect: byId<HTMLSelectElement>('thinkSelect'),
  targetSelect: byId<HTMLSelectElement>('targetSelect'),
  sendBtn: byId<HTMLButtonElement>('sendBtn'),
  stopBtn: byId<HTMLButtonElement>('stopBtn'),
  providerMeta: byId('providerMeta'),
  projectTabs: byId('projectTabs'),
  projectBody: byId('projectBody'),
  taskList: byId('taskList'),
  historyMeta: byId('historyMeta'),
  sessionList: byId('sessionList'),
  logBody: byId('logBody'),
  logLevel: byId<HTMLSelectElement>('logLevel'),
  logFilter: byId<HTMLInputElement>('logFilter'),
  logFollow: byId<HTMLInputElement>('logFollow'),
  logMeta: byId('logMeta'),
  logCopyBtn: byId<HTMLButtonElement>('logCopyBtn'),
  logClearBtn: byId<HTMLButtonElement>('logClearBtn'),
  providerList: byId('providerList'),
  providerCount: byId('providerCount'),
  providerModal: byId('providerModal'),
  providerModalTitle: byId('providerModalTitle'),
  providerModalBody: byId('providerModalBody'),
  providerModalClose: byId<HTMLButtonElement>('providerModalClose'),
  addProviderBtn: byId<HTMLButtonElement>('addProviderBtn'),
  toast: byId('toast'),
};
