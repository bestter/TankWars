import type {
  RoundEndMessage,
  ShopFinishMessage,
  ShopStateMessage,
} from "./protocol";

export type DeferredAuthoritativeTransition =
  | { readonly kind: "ROUND_END"; readonly message: RoundEndMessage }
  | { readonly kind: "SHOP_STATE"; readonly message: ShopStateMessage }
  | { readonly kind: "SHOP_FINISH"; readonly message: ShopFinishMessage };

export class DeferredTransitionBuffer {
  private pendingRoundEnd: Extract<
    DeferredAuthoritativeTransition,
    { kind: "ROUND_END" }
  > | null = null;
  private pendingShopState: Extract<
    DeferredAuthoritativeTransition,
    { kind: "SHOP_STATE" }
  > | null = null;
  private pendingShopFinish: Extract<
    DeferredAuthoritativeTransition,
    { kind: "SHOP_FINISH" }
  > | null = null;

  enqueue(item: DeferredAuthoritativeTransition): void {
    if (item.kind === "ROUND_END") {
      this.pendingRoundEnd = item;
      return;
    }
    if (item.kind === "SHOP_FINISH") {
      this.pendingShopFinish = item;
      return;
    }
    const finishEpoch = this.pendingShopFinish?.message.shopEpoch;
    if (finishEpoch !== undefined && item.message.shopEpoch <= finishEpoch) {
      return;
    }
    this.pendingShopState = item;
  }

  drain(): DeferredAuthoritativeTransition[] {
    const ordered: DeferredAuthoritativeTransition[] = [];
    if (this.pendingRoundEnd) ordered.push(this.pendingRoundEnd);
    const shopState = this.pendingShopState;
    const shopFinish = this.pendingShopFinish;
    if (
      shopState !== null &&
      shopFinish !== null &&
      shopState.message.shopEpoch > shopFinish.message.shopEpoch
    ) {
      ordered.push(shopFinish, shopState);
    } else {
      if (shopState) ordered.push(shopState);
      if (shopFinish) ordered.push(shopFinish);
    }
    this.pendingRoundEnd = null;
    this.pendingShopState = null;
    this.pendingShopFinish = null;
    return ordered;
  }

  get isEmpty(): boolean {
    return (
      this.pendingRoundEnd === null &&
      this.pendingShopState === null &&
      this.pendingShopFinish === null
    );
  }
}
