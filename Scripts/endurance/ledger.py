from model import require

class Ledger:

    def __init__(self):
        self.ledger = {}
        self.free_weapons = False
        self.stock_boundary_pending = False

    def __call__(self, row):
        """Check applied money and stocks against boundary snapshots with a bounded roster ledger."""
        ledger = self.ledger
        event = row.get('event', {})
        kind = event.get('kind')
        if kind == 'session-start':
            self.free_weapons = event['metadata']['config'].get('freeWeapons', False)
        if kind == 'round-start' and self.free_weapons:
            # Refill policy is outside this transaction audit. The first native
            # roster after the round boundary supplies opening stock balances.
            self.stock_boundary_pending = True
        if kind == 'block-start':
            self.stock_boundary_pending = False
            ledger.clear()
            for player in event.get('players', []):
                ledger[player['id']] = {'money': player['money'], 'inventory': dict(player.get('inventory', {}))}
        elif kind == 'purchase':
            purchase = event['purchase']
            require(purchase['playerId'] in ledger, 'ECONOMIC_RECONCILIATION_FAILED')
            account = ledger[purchase['playerId']]
            require(account['money'] == purchase['moneyBefore'], 'ECONOMIC_RECONCILIATION_FAILED')
            require(purchase['moneyAfter'] == purchase['moneyBefore'] - purchase['price'], 'ECONOMIC_RECONCILIATION_FAILED')
            weapon = purchase['weaponId']
            require(account['inventory'].get(weapon, 0) == purchase['stockBefore'], 'ECONOMIC_RECONCILIATION_FAILED')
            require(purchase['stockAfter'] == purchase['stockBefore'] + purchase['quantity'], 'ECONOMIC_RECONCILIATION_FAILED')
            account['money'] = purchase['moneyAfter']
            account['inventory'][weapon] = purchase['stockAfter']
        elif kind == 'combat':
            combat = event.get('event', {})
            c_kind = combat.get('kind')
            if c_kind == 'credit':
                credit = combat['credit']
                require(credit['playerId'] in ledger, 'ECONOMIC_RECONCILIATION_FAILED')
                account = ledger[credit['playerId']]
                require(account['money'] == credit['before'], 'ECONOMIC_RECONCILIATION_FAILED')
                require(credit['after'] - credit['before'] == credit['amount'], 'ECONOMIC_RECONCILIATION_FAILED')
                account['money'] = credit['after']
            elif c_kind == 'ammo-consumed':
                require(combat['after'] == combat['before'] - (0 if combat['weaponId'] == 'MISSILE' else 1), 'ECONOMIC_RECONCILIATION_FAILED')
                require(combat['playerId'] in ledger, 'ECONOMIC_RECONCILIATION_FAILED')
                account = ledger[combat['playerId']]
                require(account['inventory'].get(combat['weaponId'], 0) == combat['before'], 'ECONOMIC_RECONCILIATION_FAILED')
                account['inventory'][combat['weaponId']] = combat['after']
        for account in ledger.values():
            require(isinstance(account['money'], int) and 0 <= account['money'] <= 9007199254740991, 'ECONOMIC_RECONCILIATION_FAILED')
            require(all((isinstance(v, int) and v >= 0 for v in account['inventory'].values())), 'ECONOMIC_RECONCILIATION_FAILED')
        players = row.get('context', {}).get('players', []) if row.get('context') else []
        if kind in ('shop-start', 'shop-end'):
            players = [event['player']]
        for player in players:
            if player['id'] in ledger:
                account = ledger[player['id']]
                require(account['money'] == player['money'], 'Money reconciliation failed')
                if self.stock_boundary_pending:
                    account['inventory'] = dict(player['inventory'])
                for weapon in account['inventory'].keys() | player['inventory'].keys():
                    require(account['inventory'].get(weapon, 0) == player['inventory'].get(weapon, 0), 'Stock reconciliation failed')
        if players:
            self.stock_boundary_pending = False
