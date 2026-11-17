#!/usr/bin/env python3
"""Pubblica firestore.rules sul progetto Firebase (API Firebase Rules), al posto del copia-incolla nella console.

Usato da .github/workflows/test-regole.yml solo se TUTTI i test sull'emulatore sono passati.
Serve il segreto FIREBASE_SA (account di servizio con permesso di modificare le regole).
Scrive una riga di esito in coda a tests/rules/risultato.txt.
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RULES = os.path.join(ROOT, 'firestore.rules')
OUT = os.path.join(ROOT, 'tests', 'rules', 'risultato.txt')
API = 'https://firebaserules.googleapis.com/v1'


def esito(msg):
    print(msg, flush=True)
    try:
        with open(OUT, 'a', encoding='utf-8') as f:
            f.write(msg + '\n')
    except Exception:
        pass


def main():
    sa = os.environ.get('FIREBASE_SA', '').strip()
    if not sa:
        return esito('Pubblicazione su Firebase: saltata (manca FIREBASE_SA)')
    from google.oauth2 import service_account
    from google.auth.transport.requests import AuthorizedSession
    info = json.loads(sa)
    p = info['project_id']
    s = AuthorizedSession(service_account.Credentials.from_service_account_info(
        info, scopes=['https://www.googleapis.com/auth/firebase', 'https://www.googleapis.com/auth/cloud-platform']))
    src = open(RULES, encoding='utf-8').read()
    rel_name = 'projects/%s/releases/cloud.firestore' % p

    r = s.get('%s/%s' % (API, rel_name), timeout=30)
    if r.ok:
        cur = s.get('%s/%s' % (API, r.json()['rulesetName']), timeout=30)
        if cur.ok and any(f.get('content') == src for f in cur.json().get('source', {}).get('files', [])):
            return esito('Pubblicazione su Firebase: regole già aggiornate, niente da fare')
    elif r.status_code != 404:
        return esito('Pubblicazione su Firebase: NON riuscita (lettura %d: %s)' % (r.status_code, r.text[:200].replace('\n', ' ')))

    r = s.post('%s/projects/%s/rulesets' % (API, p), json={'source': {'files': [{'name': 'firestore.rules', 'content': src}]}}, timeout=30)
    if not r.ok:
        return esito('Pubblicazione su Firebase: NON riuscita (creazione %d: %s)' % (r.status_code, r.text[:200].replace('\n', ' ')))
    ruleset = r.json()['name']
    body = {'release': {'name': rel_name, 'rulesetName': ruleset}}
    r = s.patch('%s/%s' % (API, rel_name), json=body, timeout=30)
    if r.status_code == 404:
        r = s.post('%s/projects/%s/releases' % (API, p), json=body['release'], timeout=30)
    if not r.ok:
        return esito('Pubblicazione su Firebase: NON riuscita (attivazione %d: %s)' % (r.status_code, r.text[:200].replace('\n', ' ')))
    esito('Pubblicazione su Firebase: regole pubblicate (%s)' % ruleset.rsplit('/', 1)[-1])


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        esito('Pubblicazione su Firebase: NON riuscita (%s)' % e)
        sys.exit(0)
