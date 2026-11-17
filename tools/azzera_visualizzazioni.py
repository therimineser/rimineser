#!/usr/bin/env python3
"""Azzera i contatori delle visualizzazioni (cancella stats/views-*). Solo a mano: workflow azzera-visualizzazioni.yml.
Serve il segreto FIREBASE_SA. Non tocca stats/online."""
import json
import os
from google.oauth2 import service_account
from google.auth.transport.requests import AuthorizedSession

info = json.loads(os.environ['FIREBASE_SA'])
s = AuthorizedSession(service_account.Credentials.from_service_account_info(info, scopes=['https://www.googleapis.com/auth/datastore']))
base = 'https://firestore.googleapis.com/v1/projects/%s/databases/(default)/documents' % info['project_id']
r = s.get(base + '/stats', params={'pageSize': 300}, timeout=30)
r.raise_for_status()
n = 0
for d in r.json().get('documents', []):
    name = d['name'].rsplit('/', 1)[-1]
    if name.startswith('views-'):
        s.delete(base + '/stats/' + name, timeout=30).raise_for_status()
        print('Azzerato', name)
        n += 1
print('Contatori azzerati: %d' % n)
