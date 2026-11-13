export type AccountView = { username: string; nickname: string; crystals: number; kills: number };

type AccountResponse = { user?: AccountView | null; needsRecoveryCodes?: boolean; recoveryCodes?: string[]; error?: string };
let activeAccount: AccountView | null = null;
let lobbyConnected = false;

async function request(action?: string, values: Record<string, string> = {}): Promise<AccountResponse> {
  const response = await fetch('/api/account', {
    method: action ? 'POST' : 'GET', credentials: 'same-origin',
    headers: action ? { 'Content-Type': 'application/json' } : undefined,
    body: action ? JSON.stringify({ action, ...values }) : undefined
  });
  const result: AccountResponse = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error ?? 'Serviço de contas indisponível.');
  return result;
}

export function initializeAccountGate(connectLobby: () => void): void {
  const gate = document.createElement('div');
  gate.id = 'account-gate';
  gate.innerHTML = `
    <section class="account-card" aria-labelledby="account-title">
      <header><div class="account-mark" aria-hidden="true">▰</div><div><small>IDENTIFICAÇÃO DO COMANDANTE</small><h1 id="account-title">TANK ARENA</h1></div></header>
      <p class="account-intro">Entre ou crie uma conta para jogar e usar seu apelido nas batalhas online.</p>
      <p id="account-message" class="account-message" role="status" aria-live="polite">Verificando sua conta…</p>
      <section class="account-panel" data-account-panel="login">
        <h2>Entrar</h2><form id="account-login-form"><label>Nome de usuário<input name="username" autocomplete="username" minlength="3" maxlength="20" required></label><label>Senha<input name="password" type="password" autocomplete="current-password" minlength="12" maxlength="128" required></label><button class="account-primary" type="submit">ENTRAR NA BATALHA</button></form>
        <div class="account-links"><button type="button" data-account-view="register">Criar conta</button><button type="button" data-account-view="recover">Esqueci a senha</button></div>
      </section>
      <section class="account-panel" data-account-panel="register" hidden>
        <h2>Criar conta</h2><form id="account-register-form"><label>Nome de usuário<input name="username" autocomplete="username" minlength="3" maxlength="20" pattern="[A-Za-z0-9_]+" required><small>3–20 letras, números ou _ · usado para entrar</small></label><label>Apelido no jogo<input name="nickname" autocomplete="nickname" minlength="2" maxlength="20" required></label><label>Senha<input name="password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required><small>Use uma frase-senha longa e exclusiva.</small></label><button class="account-primary" type="submit">CRIAR CONTA</button></form><div class="account-links"><button type="button" data-account-view="login">Já tenho conta</button></div>
      </section>
      <section class="account-panel" data-account-panel="recover" hidden>
        <h2>Recuperar acesso</h2><p>Use um código de recuperação que guardou ao criar a conta. Cada código só funciona uma vez.</p><form id="account-recover-form"><label>Nome de usuário<input name="username" autocomplete="username" minlength="3" maxlength="20" required></label><label>Código de recuperação<input name="recoveryCode" autocomplete="off" autocapitalize="characters" required></label><label>Nova senha<input name="password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></label><button class="account-primary" type="submit">REDEFINIR SENHA</button></form><div class="account-links"><button type="button" data-account-view="login">Voltar para entrar</button></div>
      </section>
      <section class="account-panel" data-account-panel="codes" hidden>
        <h2>Guarde estes códigos</h2><p>Guarde-os fora do jogo. Cada código recupera a conta uma vez. Não compartilhe com ninguém.</p><div id="account-recovery-codes" class="account-recovery-codes"></div><div class="account-code-actions"><button id="account-copy-codes" type="button">COPIAR CÓDIGOS</button><button id="account-download-codes" type="button">BAIXAR ARQUIVO</button></div><button id="account-codes-confirm" class="account-primary" type="button" disabled>JÁ GUARDEI, CONTINUAR</button>
      </section>
      <footer>Sem email: a recuperação usa códigos de uso único. Senhas são armazenadas como hashes com salt.</footer>
    </section>`;
  const style = document.createElement('style');
  style.textContent = `
    #account-gate{position:fixed;inset:0;z-index:3000;display:grid;place-items:center;padding:18px;background:radial-gradient(ellipse at 50% 18%,#293c3c,#090e11 70%);color:#e7eeeb;font:14px/1.5 Inter,Segoe UI,Arial,sans-serif;user-select:text}
    #account-gate[hidden],#account-gate [hidden]{display:none!important}.account-card{width:min(440px,100%);max-height:calc(100dvh - 36px);overflow:auto;padding:clamp(20px,5vw,34px);border:1px solid #c7d8bf32;border-radius:8px;background:linear-gradient(145deg,#17201deF,#0c1213f5);box-shadow:0 30px 100px #000b}.account-card header{display:flex;align-items:center;gap:13px;padding-bottom:18px;border-bottom:1px solid #ffffff18}.account-mark{width:42px;height:42px;display:grid;place-items:center;background:#b88946;color:#101614;font-size:24px;clip-path:polygon(12% 0,100% 0,88% 100%,0 100%)}.account-card header small{color:#c6a66c;font-size:8px;letter-spacing:1.5px}.account-card h1{margin:2px 0 0;font-size:19px;letter-spacing:2px}.account-card h2{margin:18px 0 12px;font-size:19px}.account-intro,.account-panel>p{margin:16px 0;color:#aab8b6;font-size:12px;line-height:1.55}.account-message{min-height:20px;color:#d7c294;font-size:11px}.account-message.error{color:#ffab95}.account-panel form{display:grid;gap:12px}.account-panel label{display:grid;gap:5px;color:#cbd5d1;font-size:11px;font-weight:700}.account-panel label small{color:#849390;font-size:9px;font-weight:400}.account-panel input{width:100%;height:42px;padding:0 11px;border:1px solid #60726c;background:#0c1414;color:#f2f4ee;font:14px Arial,sans-serif;outline:none}.account-panel input:focus{border-color:#d1aa61;box-shadow:0 0 0 2px #d1aa6128}.account-primary,.account-code-actions button{min-height:42px;padding:0 13px;border:1px solid #d0a65e;background:linear-gradient(110deg,#815f33,#49371f);color:#fff0cc;font-size:10px;font-weight:900;letter-spacing:.8px;cursor:pointer}.account-primary:disabled{opacity:.45;cursor:not-allowed}.account-links{display:flex;justify-content:space-between;gap:10px;margin-top:13px}.account-links button{border:0;background:none;color:#c4d0ca;font:11px Arial,sans-serif;text-decoration:underline;cursor:pointer}.account-recovery-codes{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin:14px 0}.account-code{padding:8px 5px;border:1px solid #ffffff20;background:#0b1313;color:#f4dcac;text-align:center;font:700 12px/1.2 ui-monospace,monospace;user-select:text}.account-code-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:9px}.account-code-actions button{border-color:#75897d;background:#1a2925}.account-card footer{margin-top:18px;padding-top:12px;border-top:1px solid #ffffff16;color:#81908b;font-size:9px;line-height:1.5}.garage-nav-foot{gap:6px}.garage-nav-foot #garage-account-name{max-width:95px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.garage-nav-foot #account-logout{margin-left:auto;padding:4px 6px;border:1px solid #66766b66;background:#101815;color:#bdc8bf;font-size:8px;cursor:pointer}@media(max-width:480px){#account-gate{padding:12px}.account-card{max-height:calc(100dvh - 24px);padding:21px 18px}.account-card h1{font-size:17px}}
  `;
  document.head.appendChild(style);
  document.body.appendChild(gate);

  const message = gate.querySelector<HTMLElement>('#account-message')!;
  const setMessage = (value: string, error = false) => { message.textContent = value; message.classList.toggle('error', error); };
  const showPanel = (name: 'login' | 'register' | 'recover' | 'codes') => {
    gate.querySelectorAll<HTMLElement>('[data-account-panel]').forEach(panel => { panel.hidden = panel.dataset.accountPanel !== name; });
    setMessage('');
  };
  const unlock = (user: AccountView) => {
    activeAccount = user;
    const name = document.getElementById('garage-account-name');
    if (name) name.textContent = user.nickname;
    window.dispatchEvent(new CustomEvent('tank-account-ready', { detail: user }));
    gate.hidden = true;
    if (!lobbyConnected) { lobbyConnected = true; connectLobby(); }
  };
  const showCodes = (user: AccountView, codes: string[]) => {
    activeAccount = user;
    const grid = gate.querySelector<HTMLElement>('#account-recovery-codes')!;
    grid.replaceChildren(...codes.map(code => { const item = document.createElement('code'); item.className = 'account-code'; item.textContent = code; return item; }));
    gate.querySelector<HTMLButtonElement>('#account-codes-confirm')!.disabled = true;
    showPanel('codes');
    setMessage('Copie os códigos ou baixe o arquivo para continuar.');
  };
  const confirmSavedCodes = async () => {
    try { await request('confirm-codes'); if (activeAccount) unlock(activeAccount); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Não foi possível confirmar.', true); }
  };

  gate.querySelectorAll<HTMLButtonElement>('[data-account-view]').forEach(button => button.addEventListener('click', () => {
    showPanel(button.dataset.accountView as 'login' | 'register' | 'recover');
  }));
  gate.querySelector<HTMLFormElement>('#account-login-form')!.addEventListener('submit', async event => {
    event.preventDefault(); const form = new FormData(event.currentTarget as HTMLFormElement);
    try {
      setMessage('Verificando…');
      const result = await request('login', { username: String(form.get('username')), password: String(form.get('password')) });
      const status = await request();
      if (status.needsRecoveryCodes) { const rotated = await request('rotate-codes'); showCodes(result.user!, rotated.recoveryCodes!); }
      else unlock(result.user!);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Falha ao entrar.', true); }
  });
  gate.querySelector<HTMLFormElement>('#account-register-form')!.addEventListener('submit', async event => {
    event.preventDefault(); const form = new FormData(event.currentTarget as HTMLFormElement);
    try {
      setMessage('Criando conta…');
      const result = await request('register', { username: String(form.get('username')), nickname: String(form.get('nickname')), password: String(form.get('password')) });
      showCodes(result.user!, result.recoveryCodes!);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Falha ao criar conta.', true); }
  });
  gate.querySelector<HTMLFormElement>('#account-recover-form')!.addEventListener('submit', async event => {
    event.preventDefault(); const form = new FormData(event.currentTarget as HTMLFormElement);
    try {
      setMessage('Validando o código…');
      const result = await request('recover', { username: String(form.get('username')), recoveryCode: String(form.get('recoveryCode')), password: String(form.get('password')) });
      showCodes(result.user!, result.recoveryCodes!);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Não foi possível recuperar a conta.', true); }
  });
  gate.querySelector<HTMLButtonElement>('#account-copy-codes')!.addEventListener('click', async () => {
    const codes = [...gate.querySelectorAll<HTMLElement>('.account-code')].map(item => item.textContent ?? '').join('\n');
    try { await navigator.clipboard.writeText(codes); gate.querySelector<HTMLButtonElement>('#account-codes-confirm')!.disabled = false; setMessage('Códigos copiados. Guarde-os em um local seguro.'); }
    catch { setMessage('A cópia foi bloqueada. Selecione os códigos ou baixe o arquivo.'); }
  });
  gate.querySelector<HTMLButtonElement>('#account-download-codes')!.addEventListener('click', () => {
    const codes = [...gate.querySelectorAll<HTMLElement>('.account-code')].map(item => item.textContent ?? '').join('\n');
    const url = URL.createObjectURL(new Blob([`Tank Arena — códigos de recuperação\nGuarde em local seguro. Cada código só pode ser usado uma vez.\n\n${codes}\n`], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'tank-arena-codigos-recuperacao.txt'; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    gate.querySelector<HTMLButtonElement>('#account-codes-confirm')!.disabled = false;
    setMessage('Arquivo baixado. Guarde-o em local seguro.');
  });
  gate.querySelector<HTMLButtonElement>('#account-codes-confirm')!.addEventListener('click', confirmSavedCodes);
  document.getElementById('account-logout')?.addEventListener('click', async () => { try { await request('logout'); } finally { location.reload(); } });

  showPanel('login');
  void request().then(async status => {
    if (!status.user) { setMessage('Entre ou crie sua conta para jogar.'); return; }
    if (status.needsRecoveryCodes) { const result = await request('rotate-codes'); showCodes(status.user, result.recoveryCodes!); return; }
    unlock(status.user);
  }).catch(error => setMessage(error instanceof Error ? `${error.message} Atualize a página para tentar novamente.` : 'Serviço de contas indisponível.', true));
}
