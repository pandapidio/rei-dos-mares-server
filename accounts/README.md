# Contas Pandapidio Games

As contas e feedbacks usam PostgreSQL. Configure `DATABASE_URL` no serviço Railway (referência para o PostgreSQL do mesmo projeto: `${{Postgres.DATABASE_URL}}`). Use o nome real do serviço de banco na referência. Nunca faça commit de credenciais.

Sem `DATABASE_URL`, o multiplayer continua disponível e `/accounts/status` retorna `ready: false`; nenhuma conta é criada e nenhum save vai para disco efêmero. O formulário explica a indisponibilidade e o visitante mantém seus dados locais. A inicialização cria as tabelas automaticamente. Um banco inacessível impede o início da aplicação para evitar uma falsa confirmação de salvamento.

A entrada de senha acontece em `/accounts/window/`, no host Railway. O portal estático recebe apenas um token de sessão via `postMessage`, validando origem, janela e estado aleatório. Senhas usam scrypt; tokens aleatórios só são armazenados no banco como SHA-256 e expiram em 30 dias. Alterar senha exige a senha atual e revoga outras sessões.

Conta nova importa os dados locais. Login em conta existente ignora o save enviado pelo navegador. Saves são substituídos inteiros com revisão e recibo de escrita idempotente; nenhum saldo é somado. Chaves sincronizadas: `reiDosMares*`, `ayuwoke_best`, `game_complete`, `predio_esquizito_save_v2`. Tokens de sala multiplayer são específicos do dispositivo e não entram no save. Acrescente explicitamente as chaves de novos jogos aos dois validadores.

No cliente, um jogo com conta só carrega depois de restaurar o save. Falhas preservam os dados locais e impedem o boot com dados desatualizados. Mudanças locais ficam pendentes até confirmação. Conflitos nunca fazem merge: o jogador pode carregar explicitamente o save da conta; o save local anterior fica em `pg.conflictBackup`. Navegadores com Web Locks permitem uma aba de jogo por conta/origem. Ao sair da conta, os dados locais dos jogos são limpos, mantendo o progresso remoto.

O feedback exige sessão e é armazenado em `pg_feedback`, com limite de 10 por conta por dia. Não há endpoint público de listagem. A futura página administrativa deverá usar papéis atribuídos no servidor; nunca uma chave ou senha embutida no HTML. A versão atual não oferece recuperação por e-mail.

Teste: `npm run test:accounts` usa PostgreSQL via PGlite em memória, sem credenciais reais. O teste verifica criação/importação, relogin sem duplicação, senha incorreta, substituição, revisão, repetição idempotente, acesso negado, perfil, troca de senha, isolamento e feedback privado.
