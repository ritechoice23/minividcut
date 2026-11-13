use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
    thread,
};

const MAX_WORKERS: usize = 5;

pub fn worker_count(clips: usize, cpus: usize) -> usize {
    clips.min((cpus / 2).clamp(1, MAX_WORKERS))
}

pub enum Update<T> {
    Encoding(f64),
    Finished(T),
}

pub fn run<T: Send>(
    count: usize,
    workers: usize,
    encode: impl Fn(usize, &dyn Fn(f64)) -> T + Sync,
    mut update: impl FnMut(usize, Update<T>),
) {
    let next = AtomicUsize::new(0);
    let (send, receive) = mpsc::channel();
    thread::scope(|scope| {
        for _ in 0..workers {
            let send = send.clone();
            let next = &next;
            let encode = &encode;
            scope.spawn(move || loop {
                let index = next.fetch_add(1, Ordering::Relaxed);
                if index >= count {
                    break;
                }
                let report = |fraction| {
                    let _ = send.send((index, Update::Encoding(fraction)));
                };
                report(0.0);
                let result = encode(index, &report);
                let _ = send.send((index, Update::Finished(result)));
            });
        }
        drop(send);
        for (index, event) in receive {
            update(index, event);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Barrier;

    #[test]
    fn caps_parallel_exports_based_on_available_cpu_and_batch_size() {
        assert_eq!(worker_count(10, 12), 5);
        assert_eq!(worker_count(10, 4), 2);
        assert_eq!(worker_count(10, 1), 1);
        assert_eq!(worker_count(2, 16), 2);
    }

    #[test]
    fn processes_all_clips_across_two_waves_even_if_one_fails() {
        let workers = 5;
        let rendezvous = Barrier::new(workers);
        let mut started = [false; 10];
        let mut results = [None; 10];
        run(
            10,
            workers,
            |index, _| {
                rendezvous.wait();
                if index == 2 {
                    Err("one clip failed")
                } else {
                    Ok(index)
                }
            },
            |index, event| match event {
                Update::Encoding(_) => {
                    assert!(!started[index]);
                    started[index] = true;
                }
                Update::Finished(result) => {
                    assert!(started[index]);
                    assert!(results[index].replace(result).is_none());
                }
            },
        );
        assert!(started.iter().all(|&value| value));
        assert_eq!(results[2], Some(Err("one clip failed")));
        for (index, result) in results
            .into_iter()
            .enumerate()
            .filter(|(index, _)| *index != 2)
        {
            assert_eq!(result, Some(Ok(index)));
        }
    }
}
