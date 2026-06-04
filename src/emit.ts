import { type AnyFrame, type Backplane, type Codec, Frame } from "ws-asyncapi";

/**
 * Assign a recovery offset (when the backplane supports it), build and encode
 * the Event frame once, then publish it through the backplane — which fans it
 * out to every node *and* appends it to the replay log under that offset. The
 * offset is baked into the single shared payload, so the zero-copy fan-out is
 * preserved (every subscriber receives the same bytes, including the offset the
 * client uses as its recovery cursor).
 */
export async function publishEvent(
	backplane: Backplane,
	codec: Codec,
	topic: string,
	type: string,
	data: unknown,
	except?: string[],
): Promise<void> {
	const offset = backplane.assignOffset
		? await backplane.assignOffset()
		: undefined;
	const frame: AnyFrame =
		offset !== undefined
			? [Frame.Event, type, data, offset]
			: [Frame.Event, type, data];
	await backplane.publish(topic, codec.encode(frame), offset, except);
}
