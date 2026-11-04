import unittest
from ledger import Ledger


class LedgerTests(unittest.TestCase):
    def test_free_round_opening_stocks_and_later_consumption(self):
        ledger = Ledger()
        ledger(dict(event=dict(kind="session-start", metadata=dict(config=dict(freeWeapons=True)))))
        player = dict(id="p", money=100, inventory={})
        ledger(dict(event=dict(kind="block-start", players=[player])))
        ledger(dict(event=dict(kind="round-start")))
        ledger(dict(event=dict(kind="combat", event=dict(kind="decision-start")), context=dict(players=[{**player, "inventory": {"GRENADE": 3}}])))
        ledger(dict(event=dict(kind="combat", event=dict(kind="ammo-consumed", playerId="p", weaponId="GRENADE", before=3, after=2))))
        self.assertEqual(ledger.ledger["p"]["inventory"]["GRENADE"], 2)
        with self.assertRaises(ValueError):
            ledger(dict(event=dict(kind="combat", event=dict(kind="ammo-consumed", playerId="p", weaponId="GRENADE", before=3, after=2))))

    def test_boundary_never_resets_money(self):
        ledger = Ledger()
        ledger.free_weapons = True
        ledger(dict(event=dict(kind="block-start", players=[dict(id="p", money=100, inventory={})])))
        ledger(dict(event=dict(kind="round-start")))
        with self.assertRaises(ValueError):
            ledger(dict(event=dict(kind="combat", event={}), context=dict(players=[dict(id="p", money=101, inventory={})])))
