#![cfg_attr(target_arch = "wasm32", no_std)]
#![deny(unsafe_op_in_unsafe_fn)]

#[cfg(target_arch = "wasm32")]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo<'_>) -> ! {
    loop {}
}

#[cfg_attr(target_arch = "wasm32", unsafe(no_mangle))]
pub extern "C" fn smallframe_phase0_probe(input: u32) -> u32 {
    input.rotate_left(7) ^ 0x5346_5030
}

#[cfg(test)]
mod tests {
    use super::smallframe_phase0_probe;

    #[test]
    fn probe_vector_is_stable() {
        assert_eq!(smallframe_phase0_probe(0x1357_9bdf), 0xf88b_bfb9);
    }
}
