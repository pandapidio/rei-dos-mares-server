# Rei dos Mares — Multiplayer v4 autoritativo

Branch de desenvolvimento do novo multiplayer. Esta branch **não é a versão pública atual**.

## Arquitetura

Na v4, o navegador que criou a sala é líder apenas do lobby. Depois de iniciar:

- o Railway roda a simulação oficial;
- todos os jogadores enviam apenas inputs;
- o servidor calcula movimento, inimigos, projéteis, colisões, dano e ondas;
- o servidor envia snapshots a todos;
- sair o criador da sala não transfere a simulação, porque ela permanece no Railway;
- o cliente usa prediction/reconciliation para o próprio barco.

## Taxas

- Simulação: 60 Hz
- Snapshots: 20 Hz
- Inputs do cliente de teste: 50 Hz
- Reconexão: 30 s por padrão

## Teste local

```bash
npm install
npm test
npm start
```

Endpoints:

- `/` — identificação do serviço
- `/health` — healthcheck e taxas da simulação
- `/socket.io/` — transporte multiplayer

## Railway — serviço de teste

Criar **um serviço separado**, sem substituir o servidor público atual.

Repositório:

`pandapidio/rei-dos-mares-server`

Branch:

`multiplayer-v4-authoritative`

Variáveis:

```text
FRONTEND_ORIGINS=https://pandapidio.github.io
REJOIN_MS=30000
```

A branch já contém `railway.json` com uma única réplica em US East e healthcheck `/health`.

Depois de gerar o domínio público, ele deve responder com:

```json
{
  "ok": true,
  "protocol": "rdm-v4",
  "authoritative": true,
  "simulationHz": 60,
  "snapshotHz": 20
}
```

## Escopo do test1

O primeiro deploy serve para validar a arquitetura de rede antes de portar 100% das mecânicas do jogo. Já inclui:

- lobby 2–3 jogadores;
- servidor autoritativo;
- movement/input de todos;
- prediction/reconciliation;
- projéteis dos jogadores;
- inimigos básicos;
- dano;
- ondas;
- chefe de teste na onda 15;
- desconexão e retorno sem migração de host;
- pausa global;
- métricas de RTT e snapshots no cliente.

Classes, loja completa, eventos avançados, todos os bosses e todas as builds serão portados depois que a rota pública confirmar que a base de rede está suave.
