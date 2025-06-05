import {
	Component,
	type ComponentType,
	type GetDerivedStateFromError,
	type PropsWithChildren,
} from "react";

export interface ErrorBoundaryProps extends PropsWithChildren {
	fallback: ComponentType<{ error: Error }>;
}

interface ErrorBoundaryState {
	error?: Error;
}

export class ErrorBoundary extends Component<
	ErrorBoundaryProps,
	ErrorBoundaryState
> {
	override state: ErrorBoundaryState = {};

	// eslint-disable-next-line max-len
	static getDerivedStateFromError: GetDerivedStateFromError<
		ErrorBoundaryProps,
		ErrorBoundaryState
	> = (error) => ({ error });

	override componentDidCatch(error: Error) {
		this.setState({ error });
	}

	override render() {
		const {
			state: { error },
			props: { fallback: Fallback, children },
		} = this;

		return error ? <Fallback error={error} /> : children;
	}
}
