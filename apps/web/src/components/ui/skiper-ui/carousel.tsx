"use client";

import { domAnimation, LazyMotion } from "motion/react";
import * as m from "motion/react-m";
import { EffectCards } from "swiper/modules";
import { Swiper, SwiperSlide } from "swiper/react";
import "swiper/css/effect-cards";
import "swiper/css";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const Carousel = ({
	images,
	className,
	spaceBetween = 20,
	renderSlide,
}: {
	images: {
		src: string;
		alt: string;
		id?: string;
		height?: number;
		width?: number;
		is_nsfw?: boolean;
	}[];
	className?: string;
	spaceBetween?: number;
	renderSlide: (
		image: {
			src: string;
			alt: string;
			id?: string;
			height?: number;
			width?: number;
			is_nsfw?: boolean;
		},
		index: number
	) => ReactNode;
}) => {
	return (
		<LazyMotion features={domAnimation}>
			<m.div
				animate={{ opacity: 1, translateY: 0 }}
				className={cn("relative w-full max-w-3xl", className)}
				transition={{
					duration: 0.3,
					delay: 0.5,
				}}
			>
				<Swiper
					cardsEffect={{ slideShadows: false, rotate: false }}
					effect="cards"
					grabCursor={true}
					modules={[EffectCards]}
					slideToClickedSlide={true}
					spaceBetween={spaceBetween}
				>
					{images.map((image, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: images may not have stable ids
						<SwiperSlide key={index}>{renderSlide(image, index)}</SwiperSlide>
					))}
				</Swiper>
			</m.div>
		</LazyMotion>
	);
};

export { Carousel };
