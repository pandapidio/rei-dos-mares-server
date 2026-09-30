# Rei dos Mares — servidor multiplayer

Servidor autoritativo Socket.IO. O multiplayer executa os mesmos arquivos da viagem padrão, com 60 passos de simulação por segundo e snapshots a 30 Hz durante o combate. O navegador apresenta o mundo e prevê o movimento local. Escolhas de classe, melhorias, serviços e especializações passam por comandos confirmados e deduplicados no servidor.

## Produção

Node 20 ou superior. Execute `npm ci` e `npm start`. Configure `FRONTEND_ORIGINS=https://pandapidio.github.io` e opcionalmente `REJOIN_MS=30000`. O serviço usa `PORT` e escuta em `0.0.0.0`. `/health` informa versão, protocolo, frequência e salas.

## Atualizar o jogo

1. No repositório do frontend, execute `node scripts/release-rei-dos-mares.cjs X.Y.Z`.
2. Salve o commit do frontend.
3. Execute `node scripts/sync-game-source.js /frontend/games/rei-dos-mares FRONTEND_COMMIT` neste repositório. O manifesto registra a origem e os hashes dos arquivos originais; não edite `shared-game` manualmente.
4. Atualize a versão do serviço e pacote, execute `npm run check`, `npm test` e `npm run test:network`.
5. Publique o servidor e depois o frontend. O CI compara a cópia com o commit exato do frontend.

A simulação headless usa jsdom apenas como adaptador do DOM/canvas/áudio; ondas, inimigos, eventos, chefes, colisões e builds continuam nos arquivos originais. Tempos de combate vêm dos passos da simulação, e a pausa congela esses passos. Cada viagem recebe um identificador para rejeitar comandos e snapshots da viagem anterior. A sala continua existindo após a derrota ou vitória, conservando identidades e código.

## Testes

`npm test` percorre 13 papéis de inimigos, 10 eventos, os três chefes, 33 melhorias, disparos e reparos de todos os capitães e dificuldade sem escala por jogador. `npm run test:network` verifica três conexões reais, movimento, pausa, reconexão, loja, deduplicação de compras e retorno à mesma party. Controles `test:*` são registrados somente com `RDM_TESTING=1`; deixe essa variável ausente em produção.
